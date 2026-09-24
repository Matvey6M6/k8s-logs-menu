import { execFile, spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { createWriteStream, existsSync, readdirSync, statSync } from "fs";
import * as os from "os";
import * as path from "path";
import type { KubectlInfo } from "../common/types";

const isWindows = process.platform === "win32";
const binaryName = isWindows ? "kubectl.exe" : "kubectl";

function extraPathDirs(): string[] {
  const home = os.homedir();

  if (isWindows) {
    return [
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Kubernetes", "Minikube"),
      path.join(home, "scoop", "shims"),
      path.join(process.env.ChocolateyInstall || "C:\\ProgramData\\chocolatey", "bin"),
    ];
  }

  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/local/bin",
    "/usr/bin",
    "/bin",
    "/snap/bin",
    path.join(home, "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".rd", "bin"), 
    path.join(home, ".docker", "bin"),
    path.join(home, "google-cloud-sdk", "bin"),
  ];
}

export function buildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const sep = isWindows ? ";" : ":";
  const current = (env.PATH || env.Path || "").split(sep).filter(Boolean);
  const merged = [...current];

  for (const dir of extraPathDirs()) {
    if (!merged.includes(dir)) merged.push(dir);
  }

  env.PATH = merged.join(sep);

  return env;
}

function isExecutableFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function lensBundledKubectl(userDataPath?: string): string[] {
  if (!userDataPath) return [];

  const root = path.join(userDataPath, "binaries", "kubectl");
  const found: string[] = [];

  try {
    for (const version of readdirSync(root)) {
      const candidate = path.join(root, version, binaryName);

      if (isExecutableFile(candidate)) found.push(candidate);
    }
  } catch {

  }

  return found.sort().reverse();
}

export interface ResolveKubectlOptions {

  override?: string;

  preference?: string;

  userDataPath?: string;
}

export function resolveKubectl(options: ResolveKubectlOptions = {}): { path?: string; searched: string[] } {
  const searched: string[] = [];
  const candidates: string[] = [];

  if (options.override?.trim()) candidates.push(options.override.trim());
  if (options.preference?.trim()) candidates.push(options.preference.trim());
  if (process.env.KUBECTL_PATH) candidates.push(process.env.KUBECTL_PATH);

  candidates.push(...lensBundledKubectl(options.userDataPath));

  const sep = isWindows ? ";" : ":";
  const pathDirs = (buildEnv().PATH || "").split(sep).filter(Boolean);

  for (const dir of pathDirs) candidates.push(path.join(dir, binaryName));

  for (const candidate of candidates) {
    searched.push(candidate);

    if (isExecutableFile(candidate)) {
      return { path: candidate, searched };
    }
  }

  return { searched };
}

export interface ExecOptions {
  kubeconfig: string;
  context: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export class KubectlError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null) {
    super(message);
    this.name = "KubectlError";
  }
}

function baseArgs(options: ExecOptions): string[] {
  const args: string[] = [];

  if (options.kubeconfig) args.push("--kubeconfig", options.kubeconfig);
  if (options.context) args.push("--context", options.context);

  return args;
}

export function splitKubectlErrors(stderr: string): string[] {
  return (stderr || "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/^(W\d|I\d|Flag --)/.test(line))
    .map(line => line.replace(/^Error from server \(([^)]+)\):\s*/, "$1: "));
}

function shortStderr(stderr: string): string {
  const text = (stderr || "").trim();

  if (text.length <= 600) return text;

  return `${text.slice(0, 600)}...`;
}

export class Kubectl {
  private readonly running = new Set<ChildProcess>();

  constructor(readonly binary: string) {}

  run(args: string[], options: ExecOptions): Promise<string> {
    const argv = [...baseArgs(options), ...args];

    return new Promise((resolve, reject) => {
      const child = execFile(this.binary, argv, {
        env: buildEnv(),
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        this.running.delete(child);

        if (error) {
          const failure: { code?: number | string } = error;
          const code: number | null = typeof failure.code === "number" ? failure.code : null;

          reject(new KubectlError(
            `kubectl ${args.slice(0, 2).join(" ")} завершился с ошибкой: ${shortStderr(stderr) || error.message}`,
            stderr,
            code,
          ));

          return;
        }

        resolve(stdout);
      });

      this.running.add(child);
    });
  }

  async json<T = unknown>(args: string[], options: ExecOptions): Promise<T> {
    const stdout = await this.run([...args, "-o", "json"], options);

    return JSON.parse(stdout) as T;
  }

  jsonTolerant<T = unknown>(args: string[], options: ExecOptions): Promise<{ data?: T; warnings: string[] }> {
    const argv = [...baseArgs(options), ...args, "-o", "json"];

    return new Promise(resolve => {
      const child = execFile(this.binary, argv, {
        env: buildEnv(),
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        this.running.delete(child);

        let data: T | undefined;

        try {
          if (stdout.trim()) data = JSON.parse(stdout) as T;
        } catch {
          data = undefined;
        }

        const warnings = splitKubectlErrors(stderr);

        if (!data && error && warnings.length === 0) {
          warnings.push(shortStderr(stderr) || error.message);
        }

        resolve({ data, warnings });
      });

      this.running.add(child);
    });
  }

  logsToFile(args: string[], destination: string, options: ExecOptions): Promise<{ bytes: number }> {
    const argv = [...baseArgs(options), ...args];

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, argv, { env: buildEnv(), windowsHide: true });
      const out = createWriteStream(destination);
      let bytes = 0;
      let stderr = "";
      let settled = false;

      this.running.add(child);

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.running.delete(child);

        if (error) reject(error);
        else resolve({ bytes });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      child.stdout.pipe(out);

      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString();
      });

      child.on("error", err => finish(err));
      child.on("close", code => {
        out.end(() => {
          if (code === 0) {
            finish();
          } else {
            finish(new KubectlError(`kubectl logs завершился с кодом ${code}: ${shortStderr(stderr)}`, stderr, code));
          }
        });
      });
    });
  }

  killAll(): void {
    for (const child of this.running) {
      try {
        child.kill();
      } catch {

      }
    }

    this.running.clear();
  }
}

export async function kubectlVersion(binary: string): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile(binary, ["version", "--client", "-o", "json"], {
      env: buildEnv(),
      timeout: 15_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve(undefined);

        return;
      }

      try {
        const parsed = JSON.parse(stdout);

        resolve(parsed?.clientVersion?.gitVersion ?? undefined);
      } catch {
        resolve(stdout.trim().split("\n")[0]);
      }
    });
  });
}

export async function describeKubectl(options: ResolveKubectlOptions): Promise<KubectlInfo> {
  const { path: found, searched } = resolveKubectl(options);

  if (!found) {
    return {
      searched,
      error: "kubectl не найден. Установите его или укажите путь вручную в поле ниже.",
    };
  }

  const version = await kubectlVersion(found);

  return { path: found, version, searched };
}
