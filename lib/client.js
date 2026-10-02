/**
 * dsh-qoduck-pet — 浏览器半部。
 *
 * 这里**不渲染桌宠**。桌宠是一个独立的桌面窗口，由宿主半部拉起的 pet.ps1 承载
 * （见 lib/index.js 顶部说明）。浏览器这一侧只提供一个设置页，用来开关桌宠、
 * 调尺寸与活动卡片，并显示当前姿态与窗口进程是否在跑。
 *
 * 样式沿用宿主主题 token，样式表作为 React 元素挂在组件里，卸载即移除；
 * 文案走 Client locale 服务。
 */
(function () {
	window.__ModuleLoader__.load({
		id: "dsh-qoduck-pet",
		factory: (require) => {
			var module = { exports: {} };
			var exports = module.exports;
			const react = require("react");

			const API = "/api/qoduck-pet";
			const LOCALE_NS = "qoduck-pet";

			const MIN_SIZE = 48;
			const MAX_SIZE = 384;
			/** 与宿主半部 DEFAULT_CONFIG.size 保持一致。 */
			const DEFAULT_SIZE = 84;
			const POLL_MS = 1500;


			const DICT_ZH = {
				"settings.title": "Qoduck",
				"settings.intro": "Qoder 的 Qoduck 桌宠复刻",
				"settings.loading": "读取桌宠状态…",
				"settings.group.appearance": "外观",
				"settings.group.runtime": "运行",
				"settings.enabled": "显示桌宠",
				"settings.enabledHint": "关掉会结束窗口进程",
				"settings.card": "活动卡片",
				"settings.cardHint": "在宠物上方显示当前会话的标题、状态与停止/回复操作",
				"settings.size": "尺寸",
				"settings.status": "当前状态",
				"settings.process": "窗口进程",
				"settings.processUp": "运行中",
				"settings.processDown": "未运行",
				"phase.idle": "空闲",
				"phase.running": "正在工作",
				"phase.waiting": "需要你的操作",
				"phase.review": "结果可查看",
				"phase.failed": "执行受阻",
				"phase.interrupted": "已中断",
			};

			const DICT_EN = {
				"settings.title": "Qoduck",
				"settings.intro": "Qoder's Qoduck, as a desk pet",
				"settings.loading": "Reading pet state…",
				"settings.group.appearance": "Appearance",
				"settings.group.runtime": "Runtime",
				"settings.enabled": "Show pet",
				"settings.enabledHint": "Turning it off ends the window process",
				"settings.card": "Activity card",
				"settings.cardHint": "Shows the active session's title, state, and stop/reply controls above the pet",
				"settings.size": "Size",
				"settings.status": "Current state",
				"settings.process": "Window process",
				"settings.processUp": "running",
				"settings.processDown": "not running",
				"phase.idle": "Idle",
				"phase.running": "Working",
				"phase.waiting": "Needs your input",
				"phase.review": "Result ready",
				"phase.failed": "Run blocked",
				"phase.interrupted": "Interrupted",
			};

			// 颜色一律走宿主主题 token；只有素材本身用自带配色。
			const CSS = [
				".qoduck-settings{display:flex;flex-direction:column;gap:14px;max-width:560px;padding:2px 0 20px;}",
				".qoduck-head{display:flex;flex-direction:column;gap:2px;padding:0 0 4px;}",
				// 字号/字重/行高对齐 DSH 原生设置页内容区标题（16px/500/24px）
				".qoduck-head-title{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary);}",
				".qoduck-head-desc{margin:0;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);}",
				".qoduck-group{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;}",
				".qoduck-group-title{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-secondary);padding:9px 14px 7px;background:var(--dsw-alias-fill-l2);border-bottom:1px solid var(--dsw-alias-border-l1);}",
				".qoduck-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:11px 14px;}",
				".qoduck-row+.qoduck-row{border-top:1px solid var(--dsw-alias-border-l1);}",
				".qoduck-label{font-size:13px;color:var(--dsw-alias-label-primary);}",
				".qoduck-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin-top:3px;}",
				".qoduck-control{flex:0 0 auto;display:flex;align-items:center;gap:10px;}",
				".qoduck-value{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:52px;text-align:right;font-variant-numeric:tabular-nums;}",
				".qoduck-status{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--dsw-alias-label-primary);}",
				".qoduck-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;background:var(--dsw-alias-state-idle-primary);}",
				".qoduck-dot[data-up='true']{background:var(--dsw-alias-state-success-primary);}",
				".qoduck-dot[data-phase='failed']{background:var(--dsw-alias-state-error-primary);}",
				".qoduck-dot[data-phase='waiting']{background:var(--dsw-alias-state-warn-primary);}",
				".qoduck-dot[data-phase='interrupted']{background:var(--dsw-alias-state-warn-primary);}",
				".qoduck-dot[data-phase='running']{background:var(--dsw-alias-brand-primary);}",
				".qoduck-range{width:170px;cursor:pointer;}",
				".qoduck-loading{font-size:12px;color:var(--dsw-alias-label-secondary);padding:6px 2px;}",
			].join("");

			function SettingsStyles() {
				return react.createElement("style", { "data-qoduck-pet": "" }, CSS);
			}

			/** 一组设置：带标题的卡片容器。 */
			function Group(props) {
				return react.createElement(
					"section",
					{ className: "qoduck-group" },
					props.title && react.createElement("h4", { className: "qoduck-group-title" }, props.title),
					props.children,
				);
			}

			function Row(props) {
				return react.createElement(
					"div",
					{ className: "qoduck-row" },
					react.createElement(
						"div",
						null,
						react.createElement("div", { className: "qoduck-label" }, props.label),
						props.hint && react.createElement("div", { className: "qoduck-hint" }, props.hint),
					),
					react.createElement("div", { className: "qoduck-control" }, props.children),
				);
			}

			function Toggle(props) {
				return react.createElement("input", {
					type: "checkbox",
					role: "switch",
					"aria-checked": props.checked ? "true" : "false",
					checked: !!props.checked,
					onChange: (event) => props.onChange(event.target.checked),
					style: { width: 16, height: 16, cursor: "pointer" },
				});
			}

			/** 一个只读的运行状态条目：左侧标签，右侧状态点 + 文案。 */
			function StatusRow(props) {
				return react.createElement(
					"div",
					{ className: "qoduck-row" },
					react.createElement("div", { className: "qoduck-label" }, props.label),
					react.createElement(
						"div",
						{ className: "qoduck-status" },
						react.createElement("span", {
							className: "qoduck-dot",
							"data-up": props.up ? "true" : "false",
							"data-phase": props.phase || "",
						}),
						props.text,
					),
				);
			}

			function SettingsSection(props) {
				const t = props.t;
				const [state, setState] = react.useState(null);

				const reload = react.useCallback(() => {
					fetch(API + "/state", { headers: { accept: "application/json" } })
						.then((response) => (response.ok ? response.json() : null))
						.then((data) => {
							if (data && data.ok) setState(data);
						})
						.catch(() => {});
				}, []);

				react.useEffect(() => {
					reload();
					const timer = window.setInterval(reload, POLL_MS);
					return () => window.clearInterval(timer);
				}, [reload]);

				const patch = react.useCallback((change) => {
					setState((prev) => (prev ? { ...prev, config: { ...prev.config, ...change } } : prev));
					fetch(API + "/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(change),
					})
						.then((response) => (response.ok ? response.json() : null))
						.then((data) => {
							if (data && data.config) setState((prev) => (prev ? { ...prev, config: data.config } : prev));
						})
						.catch(() => {});
				}, []);

				if (!state) {
					return react.createElement(
						"div",
						{ className: "qoduck-settings" },
						react.createElement(SettingsStyles, null),
						react.createElement("div", { className: "qoduck-loading" }, t("settings.loading")),
					);
				}

				const config = state.config || {};
				const phase = state.phase || "idle";

				return react.createElement(
					"div",
					{ className: "qoduck-settings" },
					react.createElement(SettingsStyles, null),
					react.createElement(
						"header",
						{ className: "qoduck-head" },
						react.createElement("h3", { className: "qoduck-head-title" }, t("settings.title")),
						react.createElement("p", { className: "qoduck-head-desc" }, t("settings.intro")),
					),

					// 运行：只读状态 + 总开关
					react.createElement(
						Group,
						{ title: t("settings.group.runtime") },
						react.createElement(StatusRow, {
							label: t("settings.status"),
							phase: phase,
							up: state.running,
							text: t("phase." + phase),
						}),
						react.createElement(StatusRow, {
							label: t("settings.process"),
							up: state.running,
							text: state.running ? t("settings.processUp") : t("settings.processDown"),
						}),
						react.createElement(
							Row,
							{ label: t("settings.enabled"), hint: t("settings.enabledHint") },
							react.createElement(Toggle, {
								checked: config.enabled !== false,
								onChange: (value) => patch({ enabled: value }),
							}),
						),
					),

					// 外观：卡片开关 + 尺寸
					react.createElement(
						Group,
						{ title: t("settings.group.appearance") },
						react.createElement(
							Row,
							{ label: t("settings.card"), hint: t("settings.cardHint") },
							react.createElement(Toggle, {
								checked: config.showCard !== false,
								onChange: (value) => patch({ showCard: value }),
							}),
						),
						react.createElement(
							Row,
							{ label: t("settings.size") },
							react.createElement("input", {
								type: "range",
								className: "qoduck-range",
								min: MIN_SIZE,
								max: MAX_SIZE,
								step: 4,
								value: config.size || DEFAULT_SIZE,
								onChange: (event) => patch({ size: Number(event.target.value) }),
								"aria-label": t("settings.size"),
							}),
							react.createElement("span", { className: "qoduck-value" }, (config.size || DEFAULT_SIZE) + " px"),
						),
					),
				);
			}

			// ================================================================
			// 插件定义
			// ================================================================

			const name = "qoduck-pet";
			/** 只有设置页，没有页内浮层；`locale` 供文案，`slots` 供挂载。 */
			const inject = ["slots", "locale"];

			function apply(ctx) {
				const locale = ctx.locale;
				const disposers = [
					locale.register(LOCALE_NS, "zh", DICT_ZH),
					locale.register(LOCALE_NS, "en", DICT_EN),
				];
				ctx.effect(() => () => {
					for (const dispose of disposers) {
						try { dispose?.(); } catch { /* 已释放 */ }
					}
				}, "qoduck-pet: locale dictionaries");

				const t = locale.bind(LOCALE_NS);

				ctx.slots.inject("settings.section", () =>
					ctx.slots.register(
						{ name: "settings.section", id: "qoduck-pet", order: 140, label: t("settings.title") },
						() => react.createElement(SettingsSection, { t }),
					),
				);
			}

			exports.apply = apply;
			exports.inject = inject;
			exports.name = name;
			exports.__test = { DICT_ZH, DICT_EN, LOCALE_NS, MIN_SIZE, MAX_SIZE, DEFAULT_SIZE };
			return module.exports;
		},
	});
})();
