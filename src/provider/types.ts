export type ProviderName = "ollama" | "cura";

export interface Provider {
  readonly name: ProviderName;
  /** Display label for the active model (e.g. "smollm2:135m"). */
  activeModel(): string;
  /** True if the provider is reachable right now. Should be cheap and silent. */
  ping(): Promise<boolean>;
  /** True if the named model is available. */
  hasModel(model?: string): Promise<boolean>;
  /** Generate text from a prompt. Throws on transport failure. */
  generate(prompt: string): Promise<string>;
}
