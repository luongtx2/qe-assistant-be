import { FastifyInstance } from 'fastify';

export interface DOMCaptureRequest {
  stepId: string;
  description: string;
  action: string;
  context: string;
}

export interface DOMCaptureResult {
  success: boolean;
  domContext: string;
  selectors: string[];
  error?: string;
}

export interface PreflightCheckRequest {
  stepId: string;
  selector: string;
  action: string;
}

export interface PreflightCheckResult {
  stepId: string;
  selector: string;
  exists: boolean;
  isVisible?: boolean;
  isInteractable?: boolean;
  error?: string;
}

export interface RunScriptRequest {
  steps: any[];
  options?: {
    recordVideo?: boolean;
    screenshotOnFail?: boolean;
  };
}

export interface RunScriptResult {
  success: boolean;
  runId?: string;
  results?: any[];
  error?: string;
  screenshotUrl?: string;
  videoUrl?: string;
}

class ExtensionBridge {
  private fastify: FastifyInstance;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
  }

  /**
   * Send DOM capture request to extension for specific step
   */
  async sendDOMCaptureForStep(tabId: number, request: DOMCaptureRequest): Promise<DOMCaptureResult> {
    try {
      this.fastify.log.info({ tabId, request }, 'Sending DOM capture request to extension');

      // Check if this step requires navigation to different page
      const requiresNavigation = this.checkIfRequiresNavigation(request.description, request.action);
      
      if (requiresNavigation) {
        return {
          success: false,
          domContext: '',
          selectors: [],
          error: 'different page'
        };
      }

      // In a real implementation, this would use Chrome Extension Messaging API
      // For now, we'll simulate the response
      const mockResponse: DOMCaptureResult = {
        success: true,
        domContext: this.generateMockDOMContext(request),
        selectors: this.generateMockSelectors(request),
      };

      this.fastify.log.info({ mockResponse }, 'DOM capture response');
      return mockResponse;

    } catch (error: any) {
      this.fastify.log.error('Failed to send DOM capture request:', error);
      return {
        success: false,
        domContext: '',
        selectors: [],
        error: error.message
      };
    }
  }

  /**
   * Send preflight check request to extension
   */
  async sendPreflightCheck(tabId: number, selectors: PreflightCheckRequest[]): Promise<PreflightCheckResult[]> {
    try {
      this.fastify.log.info({ tabId, selectors }, 'Sending preflight check to extension');

      // Mock preflight check results
      const results: PreflightCheckResult[] = selectors.map(req => ({
        stepId: req.stepId,
        selector: req.selector,
        exists: true, // Mock: assume all selectors exist
        isVisible: true,
        isInteractable: true,
      }));

      this.fastify.log.info({ results }, 'Preflight check results');
      return results;

    } catch (error: any) {
      this.fastify.log.error('Failed to send preflight check:', error);
      return selectors.map(req => ({
        stepId: req.stepId,
        selector: req.selector,
        exists: false,
        error: error.message
      }));
    }
  }

  /**
   * Send run script request to extension
   */
  async sendRunScript(tabId: number, steps: any[], options?: RunScriptRequest['options']): Promise<RunScriptResult> {
    try {
      this.fastify.log.info({ tabId, stepsCount: steps.length, options }, 'Sending run script request to extension');

      // Mock script execution
      const mockResult: RunScriptResult = {
        success: true,
        runId: `run_${Date.now()}`,
        results: steps.map((step, index) => ({
          stepId: step.step_id || `step_${index}`,
          success: true,
          message: `Executed ${step.action} on ${step.target}`,
          timestamp: new Date().toISOString()
        })),
        screenshotUrl: options?.screenshotOnFail ? 'https://example.com/screenshot.png' : undefined,
        videoUrl: options?.recordVideo ? 'https://example.com/video.mp4' : undefined,
      };

      this.fastify.log.info({ mockResult }, 'Run script result');
      return mockResult;

    } catch (error: any) {
      this.fastify.log.error('Failed to send run script request:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Check if step requires navigation to different page
   */
  private checkIfRequiresNavigation(description: string, action: string): boolean {
    // Simple logic to detect if step requires navigation
    const navigationKeywords = [
      'login', 'signin', 'signup', 'register', 'dashboard', 'profile', 
      'settings', 'admin', 'logout', 'home', 'main', 'index'
    ];
    
    const descriptionLower = description.toLowerCase();
    return navigationKeywords.some(keyword => descriptionLower.includes(keyword));
  }

  /**
   * Generate mock DOM context based on step description
   */
  private generateMockDOMContext(request: DOMCaptureRequest): string {
    const { description, action } = request;
    
    // Generate contextual DOM based on step description
    let mockDOM = '<html><body>';
    
    if (description.toLowerCase().includes('login')) {
      mockDOM += `
        <div class="login-form">
          <input type="email" id="email" placeholder="Email" />
          <input type="password" id="password" placeholder="Password" />
          <button id="login-btn" class="btn-primary">Login</button>
        </div>
      `;
    } else if (description.toLowerCase().includes('button')) {
      mockDOM += `
        <button id="target-button" class="btn">${description}</button>
      `;
    } else if (description.toLowerCase().includes('input') || description.toLowerCase().includes('type')) {
      mockDOM += `
        <input type="text" id="target-input" placeholder="Enter text" />
      `;
    } else {
      mockDOM += `
        <div id="target-element" class="generic-element">${description}</div>
      `;
    }
    
    mockDOM += '</body></html>';
    return mockDOM;
  }

  /**
   * Generate mock selectors based on step description
   */
  private generateMockSelectors(request: DOMCaptureRequest): string[] {
    const { description, action } = request;
    
    if (description.toLowerCase().includes('login')) {
      return ['#login-btn', '.btn-primary', 'button[type="submit"]'];
    } else if (description.toLowerCase().includes('button')) {
      return ['#target-button', '.btn', 'button'];
    } else if (description.toLowerCase().includes('input') || description.toLowerCase().includes('type')) {
      return ['#target-input', 'input[type="text"]', 'input'];
    } else {
      return ['#target-element', '.generic-element', 'div'];
    }
  }
}

export const extensionBridge = new ExtensionBridge(null as any); // Will be initialized with actual fastify instance
