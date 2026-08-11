import { isAbsolute } from "node:path";

export interface ApiCommand {
  args: readonly string[];
  executable: string;
}

export function resolveApiCommand(environment: NodeJS.ProcessEnv): ApiCommand {
  const executable = environment.SYSTEM_E2E_API_EXECUTABLE;
  if (executable === undefined) {
    return { executable: "uv", args: ["run", "--frozen", "naver-blog-api"] };
  }
  if (executable.trim() === "") {
    throw new Error("SYSTEM_E2E_API_EXECUTABLE must not be empty");
  }
  if (!isAbsolute(executable)) {
    throw new Error("SYSTEM_E2E_API_EXECUTABLE must be an absolute path");
  }
  return { executable, args: [] };
}
