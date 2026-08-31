export interface BrowserTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown, options?: { signal?: AbortSignal }): Promise<string>;
}
export interface ModelContext {
  registerTool(tool: BrowserTool, options: { signal: AbortSignal }): Promise<void> | void;
}
declare global { interface Document { readonly modelContext?: ModelContext } }
