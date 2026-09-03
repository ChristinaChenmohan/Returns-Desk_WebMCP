export function parseRunnerArgs(argv) {
  let headed = false;
  let holdOpenSeconds = 0;
  let baseUrl;
  for (const argument of argv) {
    if (argument === "--headed") headed = true;
    else if (argument === "--headless") headed = false;
    else if (argument.startsWith("--hold-open=")) {
      holdOpenSeconds = Number(argument.slice("--hold-open=".length));
      if (!Number.isFinite(holdOpenSeconds) || holdOpenSeconds < 0) throw new Error("--hold-open must be a non-negative number of seconds");
    } else if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    else if (baseUrl === undefined) baseUrl = new URL(argument).href;
    else throw new Error(`Unexpected argument: ${argument}`);
  }
  return { baseUrl, headed, holdOpenSeconds };
}

export function validateDemoUrl(value) {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("The WebMCP demo URL must use HTTPS or localhost HTTP");
  }
  return url;
}

export function buildBrowserLaunchOptions({ headed, chromeChannel, flags }) {
  return {
    browser: "chrome",
    channel: chromeChannel,
    headless: !headed,
    defaultViewport: { width: 1500, height: 940 },
    slowMo: headed ? 80 : 0,
    args: [...flags, "--ignore-certificate-errors", "--window-size=1500,940"],
  };
}

export async function runOllamaToolLoop({
  initialMessages,
  availableTools,
  execute,
  executeTool,
  onStep,
  buildContinuation,
  maxSteps = 8,
}) {
  const messages = [...initialMessages];
  const executedCalls = [];
  const steps = [];
  let toolStepCount = 0;

  while (true) {
    const selection = await execute(messages, availableTools);
    const calls = selection.toolCalls ?? [];
    if (calls.length === 0) {
      return { toolCalls: executedCalls, text: selection.text, steps, messages };
    }
    if (toolStepCount + calls.length > maxSteps) throw new Error(`Ollama agent exceeded ${maxSteps} tool steps`);

    for (const call of calls) {
      const outcome = await executeTool(call.functionName, call.args);
      if (!outcome.success) throw new Error(`${call.functionName}: ${outcome.error}`);
      const businessError = readBusinessError(outcome.result);
      if (businessError !== undefined) throw new Error(`${call.functionName}: ${businessError}`);
      toolStepCount += 1;
      const execution = { functionName: call.functionName, args: call.args, result: outcome.result };
      executedCalls.push(execution);
      messages.push(
        { role: "model", type: "functioncall", name: call.functionName, arguments: call.args },
        {
          role: "tool",
          type: "functionresponse",
          name: call.functionName,
          response: typeof outcome.result === "string" ? outcome.result : JSON.stringify(outcome.result),
        },
      );
      const continuation = buildContinuation?.({ call: execution, messages: [...messages] });
      if (continuation) messages.push({ role: "user", type: "message", content: continuation });
      const step = {
        text: selection.text,
        toolCalls: [{ toolName: call.functionName, input: call.args }],
        toolResults: [{ toolName: call.functionName, output: outcome.result }],
        availableTools,
      };
      steps.push(step);
      await onStep?.({ index: toolStepCount, call: execution, messages: [...messages] });
    }
  }
}

function readBusinessError(result) {
  let parsed = result;
  if (typeof result === "string") {
    try { parsed = JSON.parse(result); } catch { return undefined; }
  }
  const code = parsed?.error?.code;
  return typeof code === "string" ? code : undefined;
}
