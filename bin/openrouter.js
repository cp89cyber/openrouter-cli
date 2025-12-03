#!/usr/bin/env node
const fs = require('fs');
const { promisify } = require('util');
const { exec } = require('child_process');
const { Command } = require('commander');
const pkg = require('../package.json');
const execAsync = promisify(exec);

const DEFAULT_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'x-ai/grok-4.1-fast:free';
const DEFAULT_YOLO_SYSTEM = `You are an autonomous terminal agent. To reach the goal you may ask to run shell commands.
Reply ONLY with JSON using one of these shapes:
{"action":"command","command":"<shell command>","comment":"<short reason>"}
{"action":"finish","summary":"<what you accomplished>"}
Do not wrap JSON in markdown or add extra text.`;

const program = new Command();
program
  .name('openrouter')
  .description('CLI interface for models through OpenRouter')
  .version(pkg.version)
  .configureHelp({ showGlobalOptions: true });

const addCommonOptions = (cmd) =>
  cmd
    .option('-k, --api-key <key>', 'OpenRouter API key (or OPENROUTER_API_KEY)', process.env.OPENROUTER_API_KEY)
    .option('--base-url <url>', 'Override API base URL', DEFAULT_BASE_URL)
    .option('--referer <url>', 'HTTP Referer header (OPENROUTER_REFERER)', process.env.OPENROUTER_REFERER)
    .option('--title <title>', 'X-Title header (OPENROUTER_TITLE)', process.env.OPENROUTER_TITLE);

addCommonOptions(program);

const normalizeBase = (url) => url.replace(/\/$/, '');

const readStdin = () =>
  new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
    process.stdin.on('error', reject);
  });

async function resolvePrompt(promptWords, opts) {
  if (opts.file) {
    try {
      return fs.readFileSync(opts.file, 'utf8').trim();
    } catch (err) {
      throw new Error(`Unable to read file ${opts.file}: ${err.message}`);
    }
  }
  if (opts.stdin || !process.stdin.isTTY) {
    const input = await readStdin();
    if (input) return input;
  }
  if (promptWords && promptWords.length > 0) {
    return promptWords.join(' ');
  }
  throw new Error('No prompt provided. Pass text, --file, or pipe via stdin.');
}

function buildHeaders(opts) {
  const apiKey = opts.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing API key. Set OPENROUTER_API_KEY or pass --api-key.');
  }
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (opts.referer) headers['HTTP-Referer'] = opts.referer;
  if (opts.title) headers['X-Title'] = opts.title;
  return headers;
}

function handleError(err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

async function runShell(command, shellOverride) {
  try {
    const { stdout, stderr } = await execAsync(command, {
      shell: shellOverride || process.env.SHELL || '/bin/bash',
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
      code: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

function ensureOnlineSuffix(model) {
  return model.includes(':online') ? model : `${model}:online`;
}

function buildWebPlugin(opts) {
  if (!opts.web) return null;
  const plugin = { id: 'web' };

  if (opts.webEngine) {
    const engine = opts.webEngine.toLowerCase();
    if (engine === 'native' || engine === 'exa') {
      plugin.engine = engine;
    }
  }

  if (Number.isInteger(opts.webMaxResults) && opts.webMaxResults > 0) plugin.max_results = opts.webMaxResults;
  if (opts.webSearchPrompt) plugin.search_prompt = opts.webSearchPrompt;

  return plugin;
}

function outputChat(json, opts) {
  if (opts.json) {
    console.log(JSON.stringify(json, null, 2));
    return;
  }
  const message = json?.choices?.[0]?.message?.content;
  if (message) {
    console.log(message.trim());
    printAnnotations(json?.choices?.[0]?.message?.annotations, opts);
  } else {
    console.log('No message content returned.');
  }
  if (json?.usage && !opts.quiet) {
    const u = json.usage;
    const parts = [];
    if (typeof u.prompt_tokens === 'number') parts.push(`prompt=${u.prompt_tokens}`);
    if (typeof u.completion_tokens === 'number') parts.push(`completion=${u.completion_tokens}`);
    if (parts.length) console.error(`usage ${parts.join(' ')}`);
  }
}

async function streamResponse(res, opts) {
  if (!res.body) {
    throw new Error('Stream not available on response.');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  const annotations = [];
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const raw of parts) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const dataStr = line.replace(/^data:\s*/, '');
      if (!dataStr || dataStr === '[DONE]') {
        continue;
      }
      try {
        const payload = JSON.parse(dataStr);
        if (opts.json) {
          console.log(JSON.stringify(payload));
          continue;
        }
        const delta = payload?.choices?.[0]?.delta?.content;
        if (delta) process.stdout.write(delta);
        const anns = payload?.choices?.[0]?.delta?.annotations || payload?.choices?.[0]?.message?.annotations;
        if (Array.isArray(anns)) annotations.push(...anns);
      } catch (err) {
        // Ignore malformed chunks but keep going
      }
    }
  }
  if (buffer.trim().startsWith('data:')) {
    const dataStr = buffer.trim().replace(/^data:\s*/, '');
    if (dataStr && dataStr !== '[DONE]') {
      try {
        const payload = JSON.parse(dataStr);
        if (opts.json) {
          console.log(JSON.stringify(payload));
        } else {
          const delta = payload?.choices?.[0]?.delta?.content;
          if (delta) process.stdout.write(delta);
          const anns = payload?.choices?.[0]?.delta?.annotations || payload?.choices?.[0]?.message?.annotations;
          if (Array.isArray(anns)) annotations.push(...anns);
        }
      } catch (err) {
        // ignore
      }
    }
  }
  if (!opts.json) {
    process.stdout.write('\n');
    printAnnotations(annotations, opts);
  }
}

function printAnnotations(rawAnnotations, opts) {
  if (opts?.quiet) return;
  if (!Array.isArray(rawAnnotations) || rawAnnotations.length === 0) return;

  const seen = new Set();
  const items = [];

  rawAnnotations.forEach((ann) => {
    if (ann?.type !== 'url_citation' || !ann.url_citation?.url) return;
    const { url, title, content } = ann.url_citation;
    if (seen.has(url)) return;
    seen.add(url);
    items.push({ url, title, content });
  });

  if (!items.length) return;

  console.log('\nSources:');
  items.forEach((item) => {
    const title = item.title || item.url.replace(/^https?:\/\//, '');
    const snippet = item.content ? ` — ${item.content.slice(0, 140)}${item.content.length > 140 ? '…' : ''}` : '';
    console.log(`- ${title} (${item.url})${snippet}`);
  });
}

async function doChat(promptWords, opts) {
  try {
    const prompt = await resolvePrompt(promptWords, opts);
    const baseUrl = normalizeBase(opts.baseUrl || DEFAULT_BASE_URL);
    const headers = buildHeaders(opts);
    const model = opts.online ? ensureOnlineSuffix(opts.model || DEFAULT_MODEL) : (opts.model || DEFAULT_MODEL);
    const messages = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: prompt });

    const body = {
      model,
      messages,
      stream: Boolean(opts.stream),
    };

    const webPlugin = buildWebPlugin(opts);
    if (webPlugin) body.plugins = [webPlugin];

    if (typeof opts.temperature === 'number' && !Number.isNaN(opts.temperature)) body.temperature = opts.temperature;
    if (typeof opts.topP === 'number' && !Number.isNaN(opts.topP)) body.top_p = opts.topP;
    if (typeof opts.maxTokens === 'number' && !Number.isNaN(opts.maxTokens)) body.max_tokens = opts.maxTokens;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API responded ${res.status}: ${text || res.statusText}`);
    }

    if (opts.stream) {
      await streamResponse(res, opts);
    } else {
      const json = await res.json();
      outputChat(json, opts);
    }
  } catch (err) {
    handleError(err);
  }
}

async function doYolo(goalWords, opts) {
  try {
    const goal = await resolvePrompt(goalWords, opts);
    const baseUrl = normalizeBase(opts.baseUrl || DEFAULT_BASE_URL);
    const headers = buildHeaders(opts);
    const model = opts.online ? ensureOnlineSuffix(opts.model || DEFAULT_MODEL) : (opts.model || DEFAULT_MODEL);
    const maxSteps = Number.isInteger(opts.maxSteps) && opts.maxSteps > 0 ? opts.maxSteps : 8;
    const systemPrompt = opts.system || DEFAULT_YOLO_SYSTEM;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Goal: ${goal}` },
    ];

    for (let step = 1; step <= maxSteps; step++) {
      const body = {
        model,
        messages,
        stream: false,
        response_format: { type: 'json_object' },
      };

      const webPlugin = buildWebPlugin(opts);
      if (webPlugin) body.plugins = [webPlugin];

      if (typeof opts.temperature === 'number' && !Number.isNaN(opts.temperature)) body.temperature = opts.temperature;
      if (typeof opts.topP === 'number' && !Number.isNaN(opts.topP)) body.top_p = opts.topP;
      if (typeof opts.maxTokens === 'number' && !Number.isNaN(opts.maxTokens)) body.max_tokens = opts.maxTokens;

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API responded ${res.status}: ${text || res.statusText}`);
      }

      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content;
      if (!content) throw new Error('No message content returned.');

      let plan;
      try {
        plan = JSON.parse(content);
      } catch (err) {
        throw new Error(`Step ${step}: Model did not return valid JSON: ${content}`);
      }

      messages.push({ role: 'assistant', content });

      if (plan.action === 'finish') {
        if (plan.summary) console.log(plan.summary.trim());
        else console.log('Finished.');
        return;
      }

      if (plan.action !== 'command' || !plan.command) {
        throw new Error(`Step ${step}: Model response missing command to run.`);
      }

      if (plan.comment) console.error(`Reason: ${plan.comment}`);
      console.error(`[YOLO step ${step}] ${plan.command}`);

      const result = await runShell(plan.command, opts.shell);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);

      messages.push({
        role: 'user',
        content: `command: ${plan.command}\nexitCode: ${result.code}\nstdout:\n${result.stdout || '(empty)'}\nstderr:\n${result.stderr || '(empty)'}`,
      });

      if (result.code !== 0) {
        console.error(`Command exited with code ${result.code}; continuing conversation.`);
      }
    }

    console.error(`Max steps reached (${maxSteps}) without a finish action.`);
  } catch (err) {
    handleError(err);
  }
}

async function listModels(opts) {
  try {
    const baseUrl = normalizeBase(opts.baseUrl || DEFAULT_BASE_URL);
    const headers = buildHeaders(opts);
    const res = await fetch(`${baseUrl}/models`, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API responded ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json();
    const models = Array.isArray(json?.data) ? json.data : json?.models || [];

    let filtered = models;
    if (opts.search) {
      const needle = opts.search.toLowerCase();
      filtered = filtered.filter((m) => m.id?.toLowerCase().includes(needle));
    }
    if (opts.limit && Number.isInteger(opts.limit)) {
      filtered = filtered.slice(0, opts.limit);
    }

    if (opts.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    if (!filtered.length) {
      console.log('No models returned.');
      return;
    }

    filtered.forEach((m) => {
      const promptCost = m.pricing?.prompt;
      const completionCost = m.pricing?.completion;
      const pricing = promptCost || completionCost
        ? ` (prompt: ${promptCost ?? '?'} completion: ${completionCost ?? '?'})`
        : '';
      console.log(`- ${m.id}${pricing}`);
    });
  } catch (err) {
    handleError(err);
  }
}

program
  .command('chat [prompt...]')
  .description('Send a chat prompt to OpenRouter')
  .option('-m, --model <id>', 'Model id to use', DEFAULT_MODEL)
  .option('--system <text>', 'System prompt')
  .option('-f, --file <path>', 'Read prompt from file')
  .option('--stdin', 'Read prompt from stdin')
  .option('--stream', 'Stream tokens as they arrive')
  .option('--json', 'Print raw JSON response instead of message text')
  .option('--json-mode', 'Request structured JSON from the model')
  .option('--web', 'Enable built-in OpenRouter web search plugin')
  .option('--online', 'Append :online to the model id (shortcut for web search)')
  .option('--web-engine <engine>', 'Web search engine to use: auto|native|exa')
  .option('--web-max-results <n>', 'Maximum number of web results to fetch', (v) => parseInt(v, 10))
  .option('--web-search-prompt <text>', 'Custom prompt used to guide the web search')
  .option('--max-tokens <n>', 'Max tokens for completion', (v) => parseInt(v, 10))
  .option('--temperature <n>', 'Sampling temperature', (v) => parseFloat(v))
  .option('--top-p <n>', 'Nucleus sampling top-p', (v) => parseFloat(v))
  .option('--quiet', 'Suppress usage line in non-JSON mode')
  .action(function (promptWords) {
    const opts = this.optsWithGlobals();
    return doChat(promptWords, opts);
  });

program
  .command('yolo [goal...]')
  .description('Autonomous mode that lets the model run shell commands (unsafe)')
  .option('-m, --model <id>', 'Model id to use', DEFAULT_MODEL)
  .option('--system <text>', 'Override the system prompt used for autonomy')
  .option('-f, --file <path>', 'Read goal from file')
  .option('--stdin', 'Read goal from stdin')
  .option('--max-steps <n>', 'Limit number of command iterations', (v) => parseInt(v, 10))
  .option('--web', 'Enable built-in OpenRouter web search plugin')
  .option('--online', 'Append :online to the model id (shortcut for web search)')
  .option('--web-engine <engine>', 'Web search engine to use: auto|native|exa')
  .option('--web-max-results <n>', 'Maximum number of web results to fetch', (v) => parseInt(v, 10))
  .option('--web-search-prompt <text>', 'Custom prompt used to guide the web search')
  .option('--temperature <n>', 'Sampling temperature', (v) => parseFloat(v))
  .option('--top-p <n>', 'Nucleus sampling top-p', (v) => parseFloat(v))
  .option('--max-tokens <n>', 'Max tokens for each model reply', (v) => parseInt(v, 10))
  .option('--shell <path>', 'Shell to execute commands with (default $SHELL or /bin/bash)')
  .action(function (goalWords) {
    const opts = this.optsWithGlobals();
    return doYolo(goalWords, opts);
  });

program
  .command('models')
  .description('List models available via OpenRouter')
  .option('--search <term>', 'Filter models containing term (case-insensitive)')
  .option('--limit <n>', 'Limit number of models shown', (v) => parseInt(v, 10))
  .option('--json', 'Print raw JSON')
  .action(function () {
    const opts = this.optsWithGlobals();
    return listModels(opts);
  });

program.parseAsync(process.argv);
