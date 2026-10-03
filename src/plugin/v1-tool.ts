/**
 * Vendored replacement for the V1 `tool()` helper from `@opencode-ai/plugin`.
 *
 * The original SDK is a thin identity wrapper that contextually types
 * `execute(args, context)` from the zod `args` shape and exposes `tool.schema`
 * as the zod reference. We keep the identical surface in-repo so the V2 plugin
 * graph has no runtime bare-specifier imports (the V2 loader resolves those
 * from the plugin package only, and third-party transitive imports are not
 * guaranteed).
 */
import { z } from "zod";

export type ToolContext = {
  sessionID: string;
  messageID: string;
  agent: string;
  abort: AbortSignal;
};

export function tool<Args extends z.ZodRawShape>(input: {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>;
}): {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>;
} {
  return input;
}

export namespace tool {
  export const schema = z;
}

export type ToolDefinition = ReturnType<typeof tool>;