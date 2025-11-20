import { Collection, ObjectId } from 'mongodb';
import { getCollection } from '../db/mongo.js';
import {
  AutomationScript,
  CreateAutomationScript,
  GenerateAutomationInput,
  AutomationStep,
  CreateAutomationScriptSchema
} from '../schemas/automation.schema.js';
import { AzureOpenAI } from 'openai';

const AUTOMATION_COLLECTION = 'automation_scripts';

// Azure OpenAI configuration
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || '';
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || '';
const AZURE_OPENAI_MODEL = process.env.AZURE_OPENAI_MODEL || AZURE_OPENAI_DEPLOYMENT || '';
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY || '';
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || '2024-04-01-preview';

let openaiClient: AzureOpenAI | null = null;

function getOpenAIClient(): AzureOpenAI {
  if (!openaiClient) {
    if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_DEPLOYMENT || !AZURE_OPENAI_MODEL) {
      throw new Error('Azure OpenAI environment variables are not fully configured.');
    }
    openaiClient = new AzureOpenAI({
      endpoint: AZURE_OPENAI_ENDPOINT,
      apiKey: AZURE_OPENAI_API_KEY,
      deployment: AZURE_OPENAI_DEPLOYMENT,
      apiVersion: AZURE_OPENAI_API_VERSION
    });
  }
  return openaiClient;
}

const VALID_STEP_TYPES = new Set(['click', 'type', 'assert', 'wait', 'scroll', 'select', 'hover']);

export class AutomationService {
  private automationScripts: Collection<AutomationScript>;

  constructor() {
    this.automationScripts = getCollection<AutomationScript>(AUTOMATION_COLLECTION);
  }

  async createScript(input: CreateAutomationScript): Promise<AutomationScript> {
    const doc: Omit<AutomationScript, '_id'> = {
      ...input,
      scriptIndex: 0,
      currentStepIndex: 0,
      status: 'draft',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const result = await this.automationScripts.insertOne(doc as any);
    return {
      _id: result.insertedId.toString(),
      ...doc
    };
  }

  async findScriptsByConversation(convId: string): Promise<AutomationScript[]> {
    return this.automationScripts.find({ convId }).sort({ createdAt: -1 }).toArray();
  }

  async findScriptById(id: string): Promise<AutomationScript | null> {
    const _id = this.safeObjectId(id);
    if (!_id) return null;
    return this.automationScripts.findOne({ _id } as any);
  }

  async updateScriptStatus(
    id: string,
    status: AutomationScript['status'],
    result?: any,
    error?: string
  ): Promise<void> {
    const _id = this.safeObjectId(id);
    if (!_id) throw new Error('Invalid script id');
    await this.automationScripts.updateOne(
      { _id } as any,
      {
        $set: {
          status,
          updatedAt: new Date(),
          ...(result && { result }),
          ...(error && { error })
        }
      }
    );
  }

  async updateScriptSteps(id: string, newSteps: any[], stepIndex: number): Promise<AutomationScript | null> {
    const script = await this.findScriptById(id);
    if (!script) return null;

    // Normalize & dedupe incoming steps
    const incoming = this.normalizeSteps(newSteps);
    const current = script.steps || [];

    let updatedSteps: any[] = [];
    if (stepIndex >= current.length) {
      // Append
      updatedSteps = this.dedupeSteps([...current, ...incoming]);
    } else {
      // Replace from stepIndex
      updatedSteps = this.dedupeSteps([...current.slice(0, stepIndex), ...incoming]);
    }

    await this.automationScripts.updateOne(
      { _id: this.safeObjectId(id) as any },
      {
        $set: {
          steps: updatedSteps,
          currentStepIndex: Math.max(0, stepIndex),
          updatedAt: new Date()
        }
      }
    );

    return await this.findScriptById(id);
  }

  async generateAutomationScript(input: GenerateAutomationInput): Promise<AutomationScript> {
    const client = getOpenAIClient();

    // Latest script (if any)
    const existingScripts = await this.findScriptsByConversation(input.convId);
    const latestScript = existingScripts[0];

    // Conversation context (safe stringify)
    const messages = await this.getConversationMessages(input.convId);
    const conversationContext = messages
      .map((m: any) => {
        const sender = m?.sender ?? 'unknown';
        const content = Array.isArray(m?.content)
          ? m.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join(' ')
          : (typeof m?.content === 'string' ? m.content : '');
        return `${sender}: ${content}`;
      })
      .filter(Boolean)
      .join('\n');

    const existingLines =
      latestScript && Array.isArray(latestScript.steps)
        ? latestScript.steps.map((s, i) => `${i + 1}. ${s.type}: ${s.description || s.selector || ''}`).join('\n')
        : '';

    const systemPrompt = [
      'You are an automation expert. Generate ONLY the additional steps needed for the user’s latest request.',
      '',
      'CRITICAL INSTRUCTIONS:',
      '- You will see an existing script with current steps (if any).',
      '- Generate ONLY the new steps that need to be added NOW (this turn).',
      '- Do NOT regenerate or repeat existing steps.',
      '- Focus only on what the user is asking for in their latest message.',
      '',
      'Return ONLY this JSON format (no extra text):',
      '{',
      '  "stepIndex": 2,',
      '  "steps": [',
      '    {',
      '      "type": "click|type|assert|wait|scroll|select|hover",',
      '      "selector": "valid CSS selector or null",',
      '      "value": "string or null",',
      '      "description": "short imperative sentence"',
      '    }',
      '  ]',
      '}',
      '',
      'STEP INDEX RULES:',
      '- If adding to the end: stepIndex = current script length.',
      '- If replacing from position X: stepIndex = X.',
      '- If new script: stepIndex = 0.',
      '',
      'SELECTOR RULES:',
      '- Use valid CSS only (NO :contains()).',
      '- Prefer stable attributes: [data-testid], [data-cy], [aria-label], [name], [placeholder].',
      '- Examples: input[type="text"], button[type="submit"], [aria-label*="search"]',
      '',
      'Respond ONLY with JSON, no explanation.'
    ].join('\n');

    const userPrompt = [
      'Generate ONLY the additional steps needed:',
      '',
      'CONVERSATION:',
      conversationContext || '(empty)',
      '',
      latestScript
        ? `EXISTING SCRIPT (${latestScript.steps.length} steps):\n${existingLines}\n\nTASK: Add new steps at position ${latestScript.steps.length}. Do NOT repeat existing steps.`
        : 'NEW SCRIPT: Create with stepIndex = 0.',
      '',
      input.domContext ? `DOM:\n${input.domContext}` : ''
    ].join('\n');

    const response = await client.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      model: AZURE_OPENAI_MODEL, // in Azure, this is the deployment name
      temperature: 0.2,
      max_tokens: 800
    });

    const content = response.choices?.[0]?.message?.content || '';
    if (!content) {
      throw new Error('No response from AI');
    }

    const json = this.extractJSON(content);
    const { stepIndex, steps } = this.validateAIJson(json);

    // Decide update/create
    if (latestScript) {
      const idx = typeof stepIndex === 'number' ? stepIndex : latestScript.steps.length;
      const updated = await this.updateScriptSteps(latestScript._id!, steps, idx);
      return updated!;
    } else {
      const validatedScript = CreateAutomationScriptSchema.parse({
        convId: input.convId,
        userId: input.userId,
        title: 'Generated Automation',
        description: input.description,
        steps: this.normalizeSteps(steps),
        scriptIndex: 0,
        currentStepIndex: typeof stepIndex === 'number' ? stepIndex : 0,
        status: 'draft',
        createdAt: new Date(),
        updatedAt: new Date()
      } as any);

      return await this.createScript(validatedScript);
    }
  }

  private async getConversationMessages(convId: string): Promise<any[]> {
    const messagesCollection = getCollection('messages');
    return messagesCollection.find({ convId }).sort({ createdAt: 1 }).limit(20).toArray();
  }

  async executeScript(scriptId: string): Promise<{ success: boolean; result?: any; error?: string }> {
    const script = await this.findScriptById(scriptId);
    if (!script) {
      throw new Error('Script not found');
    }

    try {
      await this.updateScriptStatus(scriptId, 'running');

      // TODO: thực thi thực tế ở extension/runner
      const result = {
        executedAt: new Date().toISOString(),
        stepsExecuted: script.steps.length,
        status: 'completed'
      };

      await this.updateScriptStatus(scriptId, 'completed', result);
      return { success: true, result };
    } catch (error: any) {
      await this.updateScriptStatus(scriptId, 'failed', undefined, error.message);
      return { success: false, error: error.message };
    }
  }

  // ===== Helpers =====

  private safeObjectId(id: string): ObjectId | null {
    try {
      return new ObjectId(id);
    } catch {
      return null;
    }
  }

  private stepSig(s: any) {
    return `${(s.type || '').toLowerCase()}::${s.selector || ''}::${s.value || ''}::${(s.description || '').trim()}`;
  }

  private dedupeSteps(steps: any[]): any[] {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const s of steps) {
      const sig = this.stepSig(s);
      if (!seen.has(sig)) {
        seen.add(sig);
        out.push(s);
      }
    }
    return out;
  }

  private normalizeSteps(steps: any[]): AutomationStep[] {
    return (steps || [])
      .map((s) => {
        const type = String(s?.type || '').toLowerCase();
        if (!VALID_STEP_TYPES.has(type)) return null;
        const selector = s?.selector ?? null;
        const value = s?.value ?? null;
        const description =
          (typeof s?.description === 'string' && s.description.trim().slice(0, 200)) ||
          `${type}${selector ? ` ${selector}` : ''}`;

        // Loại các step không hợp lệ tối thiểu
        if ((type === 'click' || type === 'type' || type === 'select' || type === 'hover') && !selector) {
          return null;
        }
        if (type === 'type' && (!value || value === 'null')) {
          return null;
        }

        return {
          type,
          selector,
          value,
          description
        } as AutomationStep;
      })
      .filter(Boolean) as AutomationStep[];
  }

  private extractJSON(text: string): any {
    // strip code fences
    const stripped = text.replace(/```(?:json)?|```/g, '').trim();

    // largest top-level JSON object
    let best: { start: number; end: number } | null = null;
    const stack: number[] = [];
    for (let i = 0; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === '{') stack.push(i);
      else if (ch === '}' && stack.length) {
        const start = stack.pop()!;
        const candidate = { start, end: i + 1 };
        if (!best || candidate.end - candidate.start > best.end - best.start) best = candidate;
      }
    }
    if (!best) throw new Error('No JSON object found in AI response');

    const jsonStr = stripped.slice(best.start, best.end);
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      throw new Error('Failed to parse JSON from AI response');
    }
  }

  private validateAIJson(json: any): { stepIndex: number; steps: any[] } {
    if (typeof json !== 'object' || json === null) {
      throw new Error('AI JSON is not an object');
    }
    const stepIndexRaw = json.stepIndex;
    const stepsRaw = json.steps;

    if (!Array.isArray(stepsRaw)) {
      throw new Error('AI JSON missing steps[]');
    }
    const steps = this.normalizeSteps(stepsRaw);
    if (steps.length === 0) {
      throw new Error('AI steps[] empty after normalization');
    }

    const stepIndex =
      typeof stepIndexRaw === 'number' && stepIndexRaw >= 0 && Number.isFinite(stepIndexRaw)
        ? Math.floor(stepIndexRaw)
        : 0;

    return { stepIndex, steps };
  }
}