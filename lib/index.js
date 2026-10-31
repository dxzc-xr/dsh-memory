/**
 * dsh-memory — 跨会话记忆插件（DeepSeek Harness 宿主插件）。
 *
 * 两个动作：
 * 1. 注入：每轮对话的第一步，把「全局记忆 + 当前工作目录所属的项目记忆」作为一条
 *    标记过的上下文消息插进请求（记忆文件没变就只注入一次，变了再注入）。
 * 2. 写入：注册 `remember` 工具，模型调用它把一条记忆追加进 Markdown 文件。
 *
 * 记忆文件（纯 Markdown，可直接用编辑器改）：
 *   $DSH_HOME/memory/用户档案.md                —— 全局记忆（跨所有会话/目录）
 *   $DSH_HOME/memory/项目/<cwd 归一化>.md       —— 项目记忆（按工作目录隔离）
 *
 * 关于宿主依赖：createUserMessage / defineTool 来自 @deepseek-ai/* 包。本插件可能被
 * 以 file:// URL（插件市场热挂载）或 profile 依赖两种方式加载，故用「动态导入 + 降级
 * 实现」：导入成功走宿主实现，失败则用等价的本地实现，并在诊断日志里写明走了哪条路。
 */
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const name = "dsh-memory";
const inject = ["tools", "workingDirectory"];

/** 单条记忆字符上限。 */
const MAX_ENTRY_CHARS = 2000;
/** 注入预算：超出的部分按「保留开头、省略中间」处理。 */
const MAX_INJECT_CHARS = 8000;

function dshHome() {
	return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function memoryRoot() {
	return join(dshHome(), "memory");
}

function globalFile() {
	return join(memoryRoot(), "用户档案.md");
}

function projectFile(cwd) {
	const safe = String(cwd)
		.toLowerCase()
		.replace(/[:\\/]+/g, "-")
		.replace(/[<>"|?*\s]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return join(memoryRoot(), "项目", `${safe || "root"}.md`);
}

function today() {
	const date = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function readIfExists(file) {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return "";
		throw error;
	}
}

async function mtimeOf(file) {
	try {
		return (await stat(file)).mtimeMs;
	} catch (error) {
		if (error.code === "ENOENT") return 0;
		throw error;
	}
}

/** 追加一条记忆；文件不存在时先写标题与说明。 */
async function appendEntry(file, text, title) {
	await mkdir(dirname(file), { recursive: true });
	const current = await readIfExists(file);
	const header = current.trim().length === 0
		? `# ${title}\n\n> 由 dsh-memory 维护：每次对话开始会自动注入到模型上下文。一行一条，可直接编辑。\n\n`
		: "";
	const line = `- ${today()}：${text.replace(/\r?\n/g, " ").trim()}\n`;
	await appendFile(file, header + line, "utf8");
}

/** 去掉记忆文件自带的标题与说明行，只留正文条目（注入时已经有分节标题）。 */
function memoryBody(text) {
	return text
		.replace(/^\uFEFF/, "")
		.split(/\r?\n/)
		.filter((line) => !/^#{1,6}\s/.test(line) && !/^>\s?/.test(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 把两份记忆渲染成注入文本；都为空时返回空串（不注入）。 */
function renderInjection(globalText, projectText, cwd) {
	const sections = [];
	const globalBody = memoryBody(globalText);
	const projectBody = memoryBody(projectText);
	if (globalBody.length > 0) sections.push(`### 全局记忆（用户档案）\n${globalBody}`);
	if (projectBody.length > 0) sections.push(`### 项目记忆（${cwd}）\n${projectBody}`);
	if (sections.length === 0) return "";
	const body = sections.join("\n\n");
	const clipped = body.length > MAX_INJECT_CHARS
		? `${body.slice(0, MAX_INJECT_CHARS)}\n\n…（记忆超出预算，已截断；完整内容见记忆文件）`
		: body;
	return [
		"【dsh-memory｜自动注入的跨会话记忆，不是用户这句话的内容】",
		"以下是此前会话里记下来的长期事实与偏好，供你参考；与本轮用户要求冲突时以用户本轮要求为准。",
		"",
		clipped,
		"",
		`需要新增一条长期记忆时，调用 remember 工具（scope=project 记到当前目录，scope=global 记到全局）。`,
	].join("\n");
}

/** 诊断日志：宿主 stderr 看不到时，用它在记忆目录里确认激活、注入、写入是否发生。 */
async function noteDiagnostic(event, detail) {
	try {
		const file = join(memoryRoot(), ".dsh-memory.log");
		await mkdir(dirname(file), { recursive: true });
		const line = `${new Date().toISOString()}\t${event}\t${detail ?? ""}\n`;
		// 简单自限长：超过 64KB 就重开，避免日志无限增长。
		const size = await stat(file).then((value) => value.size).catch(() => 0);
		await (size > 64 * 1024 ? writeFile(file, line, "utf8") : appendFile(file, line, "utf8"));
	} catch {
		// 诊断日志写失败不影响主流程
	}
}

// ---------------------------------------------------------------- 宿主依赖

function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value)) deepFreeze(value[key]);
	}
	return value;
}

/** 降级版 createUserMessage（语义等价于 dsh-llm 的实现：冻结 + 新 id）。 */
function fallbackUserMessage(input) {
	return deepFreeze({ ...input, role: "user", id: randomUUID() });
}

/** 宿主工具 DSL → JSON Schema（仅在拿不到 defineTool 时使用）。 */
function dslToSchemaNode(spec) {
	if (spec === null || typeof spec !== "object") return {};
	const node = { type: spec.type };
	if (spec.description !== void 0) node.description = spec.description;
	if (spec.enum !== void 0) node.enum = spec.enum;
	if (spec.additionalProperties !== void 0) node.additionalProperties = spec.additionalProperties;
	if (spec.items !== void 0) node.items = dslToSchemaNode(spec.items);
	if (spec.properties !== void 0) {
		const properties = {};
		const required = [];
		for (const [key, field] of Object.entries(spec.properties)) {
			properties[key] = dslToSchemaNode(field);
			if (field?.required === true) required.push(key);
		}
		node.properties = properties;
		if (required.length > 0) node.required = required;
	}
	return node;
}

/** 降级版 defineTool（仅在拿不到 @deepseek-ai/dsh-tools 时使用）。 */
function fallbackDefineTool(options) {
	const parameters = dslToSchemaNode({ type: "object", properties: options.parameters ?? {}, additionalProperties: false });
	const outputSchema = dslToSchemaNode(options.output?.schema ?? { type: "object" });
	return {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render: options.output?.render ?? (() => []),
		},
		async execute(args, exec) {
			return options.execute(args, exec);
		},
	};
}

let hostDepsPromise;
/** 动态解析宿主依赖；失败则降级并记日志（不抛错，避免整棵插件树失败）。 */
function hostDeps() {
	hostDepsPromise ??= (async () => {
		try {
			const [llm, tools] = await Promise.all([
				import("@deepseek-ai/dsh-llm"),
				import("@deepseek-ai/dsh-tools"),
			]);
			if (typeof llm.createUserMessage !== "function" || typeof tools.defineTool !== "function") {
				throw new Error("@deepseek-ai/* 导入成功但缺少 createUserMessage / defineTool");
			}
			return { createUserMessage: llm.createUserMessage, defineTool: tools.defineTool, source: "host" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await noteDiagnostic("host-deps-fallback", message);
			return { createUserMessage: fallbackUserMessage, defineTool: fallbackDefineTool, source: `fallback: ${message}` };
		}
	})();
	return hostDepsPromise;
}

// ---------------------------------------------------------------- 插件本体

/**
 * 同一进程里本插件可能被挂起多份（插件管理器重载、dshmarket 热挂载、bundle 层各走一条路）。
 * 用「令牌所有权」处理：后来挂上的实例接管注入，旧实例的钩子自动变成空操作，
 * 这样既不会重复注入同一份记忆，也不会让记忆陷入「没人管」的状态。
 */
let owner = null;

async function apply(ctx) {
	const token = {};
	owner = token;
	ctx.effect(() => () => {
		if (owner === token) owner = null;
	}, "dsh-memory owner");
	/** 已注入记忆的指纹，避免同一份记忆每轮重复占 token。 */
	const injected = new WeakMap();
	const host = await hostDeps();
	await noteDiagnostic("apply", `pid=${process.pid} home=${dshHome()} deps=${host.source}`);
	const createUserMessage = host.createUserMessage;
	const defineTool = host.defineTool;

	ctx.on("agent/pre-step", async ({ agent, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		if (step !== 1) return decision;
		if (owner !== token) return decision;
		let cwd;
		try {
			cwd = await ctx.workingDirectory.ensure(agent, signal);
		} catch {
			return decision;
		}
		const globalPath = globalFile();
		const projectPath = projectFile(cwd);
		const [globalText, projectText, globalMtime, projectMtime] = await Promise.all([
			readIfExists(globalPath),
			readIfExists(projectPath),
			mtimeOf(globalPath),
			mtimeOf(projectPath),
		]);
		const text = renderInjection(globalText, projectText, cwd);
		if (text.length === 0) return decision;
		const fingerprint = `${globalMtime}|${projectMtime}|${globalText.length}|${projectText.length}`;
		if (injected.get(agent) === fingerprint) return decision;
		injected.set(agent, fingerprint);
		void noteDiagnostic("inject", `cwd=${cwd} chars=${text.length}`);
		return {
			...decision,
			messages: [
				...decision.messages,
				createUserMessage({
					content: [{ type: "text", text }],
					source: { kind: name, form: "snapshot", sections: [{ name, text }] },
				}),
			],
		};
	});

	const definition = defineTool({
		name: "remember",
		description: "把一条值得跨会话保留的长期事实写入记忆（用户偏好、纠正、项目约定、已确认的结论）。记忆会在以后的对话里自动进入上下文。只记稳定的信息，不要记一次性的过程细节。",
		parameters: {
			text: {
				type: "string",
				required: true,
				description: `要记住的内容，一条一事，不超过 ${MAX_ENTRY_CHARS} 字。`,
			},
			scope: {
				type: "string",
				enum: ["project", "global"],
				description: "project = 只在当前工作目录的项目里生效（默认）；global = 对所有会话生效。",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					scope: { type: "string", required: true },
					file: { type: "string", required: true },
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: `已写入${value.scope === "global" ? "全局" : "项目"}记忆：${value.file}`,
			}],
		},
		async execute(args, exec) {
			if (exec.agent === void 0) throw new Error("remember requires an agent Session");
			const text = String(args.text ?? "").trim();
			if (text.length === 0) throw new Error("remember requires non-empty text");
			if (text.length > MAX_ENTRY_CHARS) throw new Error(`remember accepts at most ${MAX_ENTRY_CHARS} characters`);
			const scope = args.scope === "global" ? "global" : "project";
			const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
			const file = scope === "global" ? globalFile() : projectFile(cwd);
			await appendEntry(file, text, scope === "global" ? "用户档案（全局记忆）" : `项目记忆 · ${cwd}`);
			void noteDiagnostic("remember", `scope=${scope} file=${file}`);
			return { ok: true, scope, file };
		},
	});

	/** 注册 remember。同进程里旧实例可能还占着这个名字：退避重试，仍失败就只记诊断，不影响注入。 */
	const registerTool = async (attempt = 0) => {
		try {
			ctx.tools.register(definition);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await noteDiagnostic("tool-register-failed", `attempt=${attempt} ${message}`);
			if (attempt < 3) {
				setTimeout(() => { void registerTool(attempt + 1); }, 400 * (attempt + 1)).unref?.();
			}
		}
	};
	await registerTool();
}

export { apply, inject, name };
