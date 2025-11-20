import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';

export interface DOMElement {
  tag: string;
  id?: string;
  className?: string | undefined;
  text?: string;
  placeholder?: string;
  type?: string;
  name?: string;
  value?: string;
  href?: string;
  title?: string;
  'data-testid'?: string;
  'data-cy'?: string;
  'aria-label'?: string;
  rect: { x: number; y: number; width: number; height: number };
  visible?: boolean;
  timestamp?: number;
  index: number;
}

export interface AutomationStep {
  action: 'click' | 'type' | 'navigate' | 'wait' | 'assert';
  target?: string | null;
  value?: string | null;
  description: string;
  requiresNavigation?: boolean;
  navigationGuidance?: string;
}

export interface AutomationPlan {
  steps: AutomationStep[];      // TẤT CẢ các bước (đã cộng dồn)
  currentStep: number;          // index của bước đầu tiên mới sinh thêm
  isComplete: boolean;
  needsNavigation?: boolean;
  navigationGuidance?: string;
}

export class DirectAIService {
  private openai: OpenAI;

  constructor(private fastify: FastifyInstance) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT!;
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT!;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview';

    this.openai = new OpenAI({
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      baseURL: `${endpoint}/openai/deployments/${deployment}`,
      defaultQuery: { 'api-version': apiVersion },
      defaultHeaders: { 'api-key': process.env.AZURE_OPENAI_API_KEY! },
    });
  }

  /**
   * Process user input with DOM context to generate next automation step(s)
   * -> Trả về kế hoạch ĐÃ CỘNG DỒN (existingSteps + newSteps)
   */
  async processUserInput(
    userInput: string,
    domContext: DOMElement[],
    existingSteps: AutomationStep[] = [],
    language: string = 'en'
  ): Promise<{ success: boolean; plan?: AutomationPlan; message: string }> {
    try {
      const domText = this.formatDOMForAI(domContext);
      const systemPrompt = this.createSystemPrompt(existingSteps, language);

      const userPrompt = [
        `User Request: "${userInput}"`,
        '',
        'Current DOM Context:',
        domText,
        '',
        `Existing Steps: ${existingSteps.length > 0 ? JSON.stringify(existingSteps, null, 2) : 'None'}`,
        '',
        'Please analyze the DOM and user request to determine ONLY the next step(s) for THIS TURN.',
        'Do NOT repeat previously completed steps.',
        'If the required element is not found in the current DOM, indicate that navigation is needed.',
      ].join('\n');

      const response = await this.openai.chat.completions.create({
        model: process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 1000,
        // 👇 ép trả JSON object
        response_format: { type: 'json_object' }
      });

      const aiResponse = response.choices[0]?.message?.content;
      if (!aiResponse) {
        return { success: false, message: 'No response from AI' };
      }
      
      // Parse ONLY new steps for this turn
      const newSteps = this.parseAIResponseToSteps(aiResponse);
      
      // If no new steps generated, mark as complete
      if (newSteps.length === 0) {
        console.log('No new steps generated, marking as complete');
        return {
          success: true,
          plan: {
            steps: existingSteps,
            currentStep: existingSteps.length - 1,
            isComplete: true,
            needsNavigation: false,
            navigationGuidance: undefined
          },
          message: 'No new steps needed - automation complete'
        };
      }

      // Merge with existing (dedupe)
      const merged = this.mergeSteps(existingSteps, newSteps);

      // Compute plan flags
      const firstNewIndex = existingSteps.length;
      const needsNav = newSteps.some(s => s.requiresNavigation);
      const navGuide = newSteps.find(s => s.requiresNavigation)?.navigationGuidance;
      const complete = this.computeIsComplete(merged);

      const plan: AutomationPlan = {
        steps: merged,
        currentStep: firstNewIndex,
        isComplete: complete,
        needsNavigation: needsNav || undefined,
        navigationGuidance: navGuide,
      };

      const title = merged[firstNewIndex]
        ? merged[firstNewIndex].description
        : 'No new step generated';

      return {
        success: true,
        plan,
        message: `AI processed request: ${title}`,
      };
    } catch (error: any) {
      this.fastify.log.error(error);
      return { success: false, message: `AI processing failed: ${error.message}` };
    }
  }

  /**
   * Short, AI-friendly DOM projection
   * Ưu tiên: data-testid/cy, aria-label, name, placeholder, id, class; bỏ rect để gọn.
   */
  private formatDOMForAI(domContext: DOMElement[]): string {
    const now = Date.now();
    const stale = domContext.filter(el => el.timestamp && now - el.timestamp > 30_000);
    if (stale.length > 0) {
      this.fastify.log.warn(`Detected ${stale.length} stale DOM elements (older than 30s)`);
    }

    return domContext
      .slice(0, 120)
      .map((el, i) => {
        const selector = this.generateSelector(el);
        const bits: string[] = [];
        if (el['data-testid']) bits.push(`data-testid=${JSON.stringify(el['data-testid'])}`);
        if (el['data-cy']) bits.push(`data-cy=${JSON.stringify(el['data-cy'])}`);
        if (el['aria-label']) bits.push(`aria-label=${JSON.stringify(el['aria-label'])}`);
        if (el.name) bits.push(`name=${JSON.stringify(el.name)}`);
        if (el.placeholder) bits.push(`placeholder=${JSON.stringify(el.placeholder)}`);
        if (el.type) bits.push(`type=${JSON.stringify(el.type)}`);
        const text = (el.text || '').trim();
        const textShort = text ? (text.length > 80 ? text.slice(0, 77) + '…' : text) : '';
        if (textShort) bits.push(`text=${JSON.stringify(textShort)}`);
        if (el.visible === false) bits.push(`hidden=true`);

        return `${i + 1}. <${el.tag}> ${selector ? `(${selector})` : ''} ${bits.length ? ' - ' + bits.join(' | ') : ''}`;
      })
      .join('\n');
  }

  /**
   * Generate a best-effort CSS selector
   */
  private generateSelector(el: DOMElement): string {
    if (el['data-testid']) return `[data-testid="${el['data-testid']}"]`;
    if (el['data-cy']) return `[data-cy="${el['data-cy']}"]`;
    if (el.id) return `#${el.id}`;
    if (el['aria-label']) return `[aria-label="${el['aria-label']}"]`;
    if (el.name) return `${el.tag}[name="${el.name}"]`;
    if (el.placeholder) return `${el.tag}[placeholder="${el.placeholder}"]`;
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.split(' ').filter(Boolean).join('.');
      return `${el.tag}.${classes}`;
    }
    return el.tag;
  }

  /**
   * Prompt: chỉ yêu cầu JSON và ràng buộc không duplicate
   */
  private createSystemPrompt(existing: AutomationStep[], language: string = 'en'): string {
    const langMap: Record<string, string> = {
      vi: 'Trả lời bằng JSON, không có giải thích. Mô tả ngắn gọn, tiếng Việt.',
      zh: '仅以 JSON 作答，无解释。简短中文描述。',
      ja: 'JSON のみで回答。説明なし。日本語で簡潔に。',
      ko: 'JSON만 응답, 설명 금지. 한국어로 간결히.',
      fr: 'Répondez uniquement en JSON, sans explication. Français concis.',
      de: 'Nur JSON, keine Erklärungen. Deutsch knapp.',
      es: 'Solo JSON, sin explicaciones. Español conciso.',
      en: 'Respond ONLY with JSON object, no explanations. Concise English.',
    };
    const lang = langMap[language] || 'Respond ONLY with JSON object, no explanations. Concise English.';

    const existingLines =
      existing.length > 0
        ? existing.map((s, i) => `${i + 1}. ${s.action.toUpperCase()} :: ${s.description} :: target=${s.target ?? 'null'} :: value=${s.value ?? 'null'}`).join('\n')
        : 'None';

    return [
      'You are an automation expert. Produce ONLY JSON for the NEXT step(s) of THIS TURN, based on user request and current DOM.',
      lang,
      '',
      'HARD RULES:',
      '1) NEVER duplicate any existing step.',
      '2) Return ONLY steps that should be executed NOW (for this single turn).',
      '3) If the user request is already completed by existing steps, return {"steps": []}.',
      '4) Prefer stable selectors: data-testid/data-cy/aria-label/name/placeholder before id/class.',
      '5) If element not in DOM, set requiresNavigation=true and include navigationGuidance.',
      '6) Keep descriptions short and imperative.',
      '',
      'JSON SCHEMA:',
      '{',
      '  "steps": [',
      '    {',
      '      "action": "click|type|navigate|wait|assert",',
      '      "target": "CSS selector or null",',
      '      "value": "string or null",',
      '      "description": "string",',
      '      "requiresNavigation": true|false,',
      '      "navigationGuidance": "string or null"',
      '    }',
      '  ]',
      '}',
      '',
      'EXISTING (do not duplicate):',
      existingLines,
    ].join('\n');
  }

  /**
   * Robust JSON extractor -> steps normalizer
   */
  private parseAIResponseToSteps(aiResponse: string): AutomationStep[] {
    // strip code fences if any
    const stripped = aiResponse.replace(/```(?:json)?|```/g, '').trim();

    // pick the largest top-level JSON object
    const jsonMatch = this.findLargestJsonObject(stripped);
    if (!jsonMatch) throw new Error('No JSON object found in AI response');

    let data: any;
    try {
      data = JSON.parse(jsonMatch);
    } catch (e) {
      throw new Error('JSON parse failed');
    }

    const rawSteps = Array.isArray(data?.steps) ? data.steps : [];
    if (!rawSteps.length) {
      // Return empty array instead of fallback step to avoid stuck workflow
      return [];
    }

    const normalized: AutomationStep[] = rawSteps.map((s: any) => this.normalizeStep(s)).filter(Boolean) as AutomationStep[];
    if (!normalized.length) throw new Error('No valid steps after normalization');

    return normalized;
  }

  private normalizeStep(s: any): AutomationStep | null {
    const action = String(s?.action || '').toLowerCase();
    const valid = ['click', 'type', 'navigate', 'wait', 'assert'];
    if (!valid.includes(action)) return null;

    const step: AutomationStep = {
      action: action as AutomationStep['action'],
      target: s?.target ?? null,
      value: s?.value ?? null,
      description: String(s?.description || '').slice(0, 200) || `${action} step`,
      requiresNavigation: Boolean(s?.requiresNavigation),
      navigationGuidance: s?.navigationGuidance || undefined,
    };
    // If type without value -> reject
    if (step.action === 'type' && (!step.value || step.value === 'null')) return null;
    // If click/type and no target -> allow only if requiresNavigation=true
    if ((step.action === 'click' || step.action === 'type') && !step.target && !step.requiresNavigation) return null;
    return step;
  }

  private findLargestJsonObject(text: string): string | null {
    // naive bracket counter to grab the largest {...}
    let best: { start: number; end: number } | null = null;
    const stack: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') stack.push(i);
      else if (text[i] === '}' && stack.length) {
        const start = stack.pop()!;
        const candidate = { start, end: i + 1 };
        if (!best || candidate.end - candidate.start > best.end - best.start) best = candidate;
      }
    }
    return best ? text.slice(best.start, best.end) : null;
    }

  /**
   * Merge & dedupe by signature
   */
  private mergeSteps(existing: AutomationStep[], incoming: AutomationStep[]): AutomationStep[] {
    const set = new Set(existing.map(this.stepSig));
    const merged = existing.slice();
    for (const s of incoming) {
      const sig = this.stepSig(s);
      if (!set.has(sig)) {
        merged.push(s);
        set.add(sig);
      }
    }
    return merged;
  }

  private stepSig = (s: AutomationStep) =>
    `${s.action}::${s.target ?? ''}::${s.value ?? ''}::${(s.description || '').trim()}`;

  private computeIsComplete(steps: AutomationStep[]): boolean {
    // business rule: complete if last step is assert OR a navigate to final page OR explicit wait+assert pair
    const last = steps[steps.length - 1];
    if (!last) return false;
    if (last.action === 'assert') return true;
    const hasAssert = steps.some(s => s.action === 'assert');
    if (hasAssert) return true;
    return false;
  }
}