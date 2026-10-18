const fs = require("node:fs/promises"),
  path = require("node:path"),
  { execFile } = require("node:child_process");
const { inspectImageHeader } = require("../../../src/attachments/imageHeader");
const { validateOcrResult } = require("../../../src/core/receipt");
class ReceiptServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReceiptServiceError";
    this.code = code;
  }
}
const messages = {
  OCR_FAILED:
    "Windows could not recognize this receipt. Try a clearer image or enter it manually.",
  OCR_UNAVAILABLE: "The local Windows English OCR component is unavailable.",
  IMAGE_DIMENSIONS:
    "This image exceeds the Windows OCR dimension limit. Choose a smaller image.",
  TIMEOUT:
    "Receipt recognition took too long. Try again deliberately or enter the transaction manually.",
  CANCELLED: "Receipt recognition was cancelled.",
  IMAGE_INVALID: "Choose a valid static JPEG, PNG or WebP image.",
  TOO_LARGE: "The image exceeds the 10 MiB limit.",
  WORKER_UNCONFIRMED:
    "The previous Windows recognition process has not confirmed shutdown. Its temporary files were retained; wait before retrying.",
};
function error(code) {
  return new ReceiptServiceError(code, messages[code] ?? messages.OCR_FAILED);
}
function runProcess(executable, args, options) {
  return new Promise((resolve, reject) => {
    let result = null,
      deadline,
      closed = false,
      complete;
    const completion = new Promise((done) => {
      complete = done;
    });
    const unconfirmed = () => {
      const failure = error("WORKER_UNCONFIRMED");
      failure.closed = completion;
      reject(failure);
    };
    const child = execFile(
      executable,
      args,
      {
        ...options,
        windowsHide: true,
        timeout: 35000,
        maxBuffer: 1024,
        encoding: "utf8",
      },
      (err) => {
        result = err ?? null;
        if (err && !closed) {
          clearTimeout(deadline);
          deadline = setTimeout(unconfirmed, 5000);
        }
      },
    );
    // AbortSignal can deliver execFile's error callback before the native child
    // closes. Keep the owned job alive and the companion busy until close.
    child.once("close", () => {
      closed = true;
      clearTimeout(deadline);
      complete();
      if (result) reject(result);
      else resolve();
    });
    // Also bounds a failed termination that emits neither callback nor close.
    deadline = setTimeout(unconfirmed, 40000);
  });
}
function createWindowsOcrWorker({
  workRoot = path.join(__dirname, "../../..", ".runtime", "companion", "jobs"),
  run = runProcess,
  platform = process.platform,
} = {}) {
  const root = path.resolve(workRoot),
    worker = path.join(__dirname, "Invoke-ReceiptOcr.ps1");
  const unconfirmedJobs = new Map();
  async function recognize(bytes, { signal } = {}) {
    if (unconfirmedJobs.size) throw error("WORKER_UNCONFIRMED");
    if (platform !== "win32") throw error("OCR_UNAVAILABLE");
    let info;
    let retainJob = false;
    try {
      info = inspectImageHeader(bytes);
      bytes = new Uint8Array(bytes);
    } catch {
      throw error(bytes?.byteLength > 10485760 ? "TOO_LARGE" : "IMAGE_INVALID");
    }
    if (signal?.aborted) throw error("CANCELLED");
    await fs.mkdir(root, { recursive: true });
    if ((await fs.lstat(root)).isSymbolicLink()) throw error("OCR_FAILED");
    const job = await fs.mkdtemp(path.join(root, "job-"));
    // Only this generated immediate child is eligible for recursive cleanup.
    const owned =
      path.dirname(path.resolve(job)) === root &&
      /^job-[A-Za-z0-9_-]+$/.test(path.basename(job));
    if (!owned) throw error("OCR_FAILED");
    try {
      const extension = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/webp": "webp",
      }[info.mimeType];
      await fs.writeFile(path.join(job, `input.${extension}`), bytes, {
        flag: "wx",
      });
      let failed = null;
      try {
        await run(
          path.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "RemoteSigned",
            "-File",
            worker,
            "-JobDirectory",
            job,
          ],
          { cwd: job, signal, windowsHide: true },
        );
      } catch (value) {
        failed = value;
      }
      if (failed?.code === "WORKER_UNCONFIRMED") {
        retainJob = true;
        unconfirmedJobs.set(job, true);
        if (failed.closed && typeof failed.closed.then === "function") {
          void failed.closed
            .then(() => fs.rm(job, { recursive: true, force: true }))
            .then(
              () => unconfirmedJobs.delete(job),
              () => {},
            );
        }
        throw error("WORKER_UNCONFIRMED");
      }
      if (signal?.aborted) throw error("CANCELLED");
      if (["EPERM", "EACCES", "ENOENT"].includes(failed?.code))
        throw error("OCR_UNAVAILABLE");
      if (failed?.killed || failed?.code === "ETIMEDOUT")
        throw error("TIMEOUT");
      let parsed;
      try {
        const output = path.join(job, "output.json"),
          stat = await fs.stat(output);
        if (stat.size < 1 || stat.size > 1024 * 1024) throw Error();
        parsed = JSON.parse(await fs.readFile(output, "utf8"));
      } catch {
        throw error("OCR_FAILED");
      }
      if (parsed.error)
        throw error(
          ["OCR_UNAVAILABLE", "IMAGE_DIMENSIONS"].includes(parsed.error)
            ? parsed.error
            : "OCR_FAILED",
        );
      if (failed) throw error("OCR_FAILED");
      let result;
      try {
        result = validateOcrResult(parsed);
      } catch {
        throw error("OCR_FAILED");
      }
      if (result.width !== info.width || result.height !== info.height)
        throw error("IMAGE_INVALID");
      return result;
    } finally {
      if (!retainJob) await fs.rm(job, { recursive: true, force: true });
    }
  }
  return {
    recognize,
    hasUnconfirmedProcess() {
      return unconfirmedJobs.size > 0;
    },
    async drain() {
      if (unconfirmedJobs.size) throw error("WORKER_UNCONFIRMED");
    },
  };
}
module.exports = { createWindowsOcrWorker, ReceiptServiceError, messages };
