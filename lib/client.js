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
				// intro 是这一页自己的介绍段。原生设置菜单渲染的是页面标题（Qoduck），
				// 那只是导航项的名字，不解释这个插件干什么 —— 所以这里要自己写一段。
				// 渲染它时**不要**再写一个 `settings.title` 的大标题，否则就重复了。
				"settings.intro": "桌宠是一个独立的桌面窗口，由宿主拉起，显示当前会话的状态与活动进度。",
				"settings.loading": "读取桌宠状态…",
				"settings.group.appearance": "外观",
				"settings.group.runtime": "运行",
				"settings.enabled": "显示桌宠",
				"settings.enabledHint": "关掉会结束窗口进程",
				"settings.card": "活动卡片",
				"settings.cardHint": "在宠物上方显示当前会话的标题、状态与停止/回复操作",
				"settings.size": "宠物尺寸",
				"settings.sizeHint": "桌宠窗口的边长，48–384px",
				"settings.status": "当前状态",
				"settings.process": "窗口进程",
				"settings.processUp": "已启动",
				"settings.processDown": "未运行",
				"settings.readonly": "只读",
				"phase.idle": "空闲",
				"phase.running": "正在工作",
				"phase.waiting": "需要你的操作",
				"phase.review": "结果可查看",
				"phase.failed": "执行受阻",
				"phase.interrupted": "已中断",
			};

			const DICT_EN = {
				"settings.title": "Qoduck",
				// 页首介绍段。原生设置菜单渲染的是页面标题（Qoduck），那只是导航项的
				// 名字，不解释这个插件干什么 —— 这里只补 intro，不重复写标题。
				"settings.intro": "The pet is a separate desktop window launched by the host, showing the current session's state and activity.",
				"settings.loading": "Reading pet state…",
				"settings.group.appearance": "Appearance",
				"settings.group.runtime": "Runtime",
				"settings.enabled": "Show pet",
				"settings.enabledHint": "Turning it off ends the window process",
				"settings.card": "Activity card",
				"settings.cardHint": "Shows the active session's title, state, and stop/reply controls above the pet",
				"settings.size": "Size",
				"settings.sizeHint": "Window edge length, 48–384px",
				"settings.status": "Current state",
				"settings.process": "Window process",
				"settings.processUp": "started",
				"settings.processDown": "not running",
				"settings.readonly": "Read-only",
				"phase.idle": "Idle",
				"phase.running": "Working",
				"phase.waiting": "Needs your input",
				"phase.review": "Result ready",
				"phase.failed": "Run blocked",
				"phase.interrupted": "Interrupted",
			};

			/**
			 * 设置页样式 —— 逐条对齐 DSH 原生设置页，不自己发明。
			 *
			 * 数值取自 `app.asar` 里 `dsh-client-ui-*` 的实际 CSS：
			 * 行 `_0Fr0Ha_row`（0.5px border-l2 + padding 16px 0 + 标题 14px/400
			 * + 描述 12px/18px tertiary）、开关 `Switch.module.css`（36×20）、
			 * 数值 `_0Fr0Ha_stepper`（36px 高 + radius-md + bg-module）、
			 * 卡片 `radius-xl` 20px + `settings-card-stroke` 的 0.5px hairline。
			 * 改任何一项前先回去看原生。
			 *
			 * 三条硬约束：
			 * 1. **不重复页面标题**。原生设置菜单渲染了页面标题（Qoduck），这里只补
			 *    自己的介绍段 `settings.intro`，不再画一个大标题。
			 * 2. **颜色只留给状态**。层级靠字号、字重、色深区分。
			 * 3. **只用真实存在的 token**。原先的 `--dsw-alias-fill-l2` 在原生
			 *    主题里查无此值（grep 全 theme 为 0 命中），分组标题的底色其实是
			 *    透明的 —— 变量名看着对，渲染出来什么都没有，这类坑只能靠核对 token 表发现。
			 */
			const CSS = [
				".qoduck-settings{display:flex;flex-direction:column;gap:16px;padding:8px 0;}",
				// 页首介绍：原生 models 页的 `.intro` 是 14px/22px tertiary。
				".qoduck-head{display:flex;flex-direction:column;gap:4px;}",
				".qoduck-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary);}",

				// 运行状态：两列卡片。它们是只读的，不该长得像能点的设置行。
				// 底部留 16px：和别的组最后一行（`.qoduck-row` 的 padding:16px）
				// 对齐。原先只有 4px，运行组看着像被卡片底边切了一刀。
				".qoduck-stat-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:0 16px 16px;}",
				".qoduck-stat-card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);padding:12px 14px;display:flex;flex-direction:column;gap:6px;min-width:0;}",
				".qoduck-stat-key{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
				".qoduck-stat-value{display:flex;align-items:center;gap:7px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",

				// 分组卡片
				".qoduck-group{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);overflow:hidden;}",
				".qoduck-group-head{display:flex;align-items:baseline;gap:8px;padding:14px 16px 8px;}",
				".qoduck-group-title{margin:0;font-size:13px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary);}",
				".qoduck-group-sub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",

				// 行：逐值对齐 ui-theme 的 `_0Fr0Ha_row`。
				".qoduck-row{display:flex;align-items:center;gap:8px;padding:16px;border-bottom:.5px solid var(--dsw-alias-border-l2);}",
				".qoduck-row:last-child{border-bottom:none;}",
				".qoduck-row-main{flex:1;min-width:0;padding-right:48px;display:flex;flex-direction:column;gap:4px;}",
				".qoduck-label{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary);}",
				".qoduck-hint{font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
				".qoduck-control{display:inline-flex;align-items:center;gap:8px;flex:none;}",

				// 开关：逐值对齐 Switch.module.css（36×20，border-l3 底，开时 brand-primary）。
				".qoduck-switch{box-sizing:border-box;position:relative;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer;display:inline-flex;align-items:center;transition:background .12s;}",
				".qoduck-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary);}",
				".qoduck-switch:focus-visible{outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px;}",
				".qoduck-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb, currentColor);transition:transform 120ms ease;}",
				".qoduck-switch[aria-checked='true'] .qoduck-switch-thumb{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground, #fff);}",

				// 数值：逐值对齐 ui-theme 的 `_0Fr0Ha_stepper`。
				".qoduck-stepper{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);justify-content:center;align-items:center;min-width:72px;height:36px;display:inline-flex;position:relative;padding:0 12px;gap:4px;cursor:pointer;}",
				".qoduck-stepper:hover{background:color-mix(in srgb, var(--dsw-alias-bg-module-platform) 88%, var(--dsw-alias-label-primary));}",
				".qoduck-stepper-value{text-align:center;font-variant-numeric:tabular-nums;min-width:18px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;}",
				".qoduck-stepper-unit{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px;}",

				// 状态点：颜色只出现在状态上，这是它唯一的用途。
				".qoduck-dot{width:8px;height:8px;border-radius:50%;corner-shape:round;flex:none;background:var(--dsw-alias-label-tertiary);}",
				".qoduck-dot[data-state='ok']{background:var(--dsw-alias-state-success-primary);}",
				".qoduck-dot[data-state='warn']{background:var(--dsw-alias-state-warn-primary);}",
				".qoduck-dot[data-state='error']{background:var(--dsw-alias-state-error-primary);}",
				".qoduck-dot[data-state='info']{background:var(--dsw-alias-state-business-primary);}",

				".qoduck-loading{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);padding:12px 2px;}",
			].join("");

			function SettingsStyles() {
				return react.createElement("style", { "data-qoduck-pet": "" }, CSS);
			}

			/**
			 * 一组设置：带标题的卡片容器。
			 *
			 * 标题用 `h4` 而不是 `div`：分组标题在原生里是真实的分组语义
			 * （agent-preset 的 `.KZf9OG_groupHead` 也是 h4 级别的 13px/600），
			 * 屏幕阅读器能顺着它跳。
			 */
			function Group(props) {
				return react.createElement(
					"section",
					{ className: "qoduck-group" },
					(props.title || props.sub) &&
						react.createElement(
							"div",
							{ className: "qoduck-group-head" },
							props.title && react.createElement("h4", { className: "qoduck-group-title" }, props.title),
							props.sub && react.createElement("span", { className: "qoduck-group-sub" }, props.sub),
						),
					props.children,
				);
			}

			function Row(props) {
				return react.createElement(
					"div",
					{ className: "qoduck-row" },
					react.createElement(
						"div",
						{ className: "qoduck-row-main" },
						react.createElement("div", { className: "qoduck-label" }, props.label),
						props.hint && react.createElement("div", { className: "qoduck-hint" }, props.hint),
					),
					react.createElement("div", { className: "qoduck-control" }, props.children),
				);
			}

			/**
			 * 开关 —— 逐值对齐 `primitives/lib/Switch.module.css`。
			 *
			 * 原生 `Switch` 组件在插件侧拿不到（它在 primitives 的运行时里，
			 * 不走 `settings.section` 的注入面），所以照它的 CSS 自己画。
			 *
			 * 关键：**用 `aria-checked` 驱动外观**，不是另开一个 class。
			 * 这样视觉状态不可能与无障碍状态不一致 —— 原生注释里专门写了这一点。
			 *
			 * 颜色也照抄：关是 `border-l3` 灰，开是 `brand-primary`（深色下近白，
			 * **不是绿色**）。原先用 `state-success` 绿是错的 —— 那是状态色，
			 * 而「开关打开」不是异常也不是成功。
			 */
			function Toggle(props) {
				const on = !!props.checked;
				return react.createElement(
					"button",
					{
						type: "button",
						role: "switch",
						className: "qoduck-switch",
						"aria-checked": on ? "true" : "false",
						"aria-label": props.label || undefined,
						onClick: () => props.onChange(!on),
					},
					react.createElement("span", { className: "qoduck-switch-thumb", "aria-hidden": "true" }),
				);
			}

			/**
			 * 数值框 —— 逐值对齐 ui-theme 的 `_0Fr0Ha_stepper`。
			 *
			 * 点左半边减、右半边加，步进 4px。用 button 而不是裸 input：
			 * 原生那一处也是这个交互，滑块只在 hover 时才浮现箭头。
			 */
			function Stepper(props) {
				const step = props.step || 4;
				const min = props.min;
				const max = props.max;
				const value = props.value;
				const nudge = (delta) => {
					const next = Math.min(max, Math.max(min, value + delta));
					if (next !== value) props.onChange(next);
				};
				return react.createElement(
					"div",
					{
						className: "qoduck-stepper",
						role: "group",
						"aria-label": props.label || undefined,
						onClick: (event) => {
							// 按容器中线分左右：左半减、右半加。
							const rect = event.currentTarget.getBoundingClientRect();
							nudge(event.clientX < rect.left + rect.width / 2 ? -step : step);
						},
					},
					react.createElement("span", { className: "qoduck-stepper-value" }, String(value)),
					props.unit && react.createElement("span", { className: "qoduck-stepper-unit" }, props.unit),
				);
			}

			/**
			 * 一个只读状态卡：标题 + 状态点 + 文案。
			 *
			 * 「当前状态」和「窗口进程」都是只读的观测值，不是设置项 —— 混在设置行里
			 * 会让人以为能点。所以单独成卡，两张并排。
			 */
			function StatCard(props) {
				return react.createElement(
					"div",
					{ className: "qoduck-stat-card" },
					react.createElement("span", { className: "qoduck-stat-key" }, props.label),
					react.createElement(
						"span",
						{ className: "qoduck-stat-value" },
						react.createElement("span", {
							className: "qoduck-dot",
							"data-state": props.state || "",
							"aria-hidden": "true",
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

					// 页首只放介绍段。页面标题（Qoduck）由原生设置菜单渲染，
					// 这里再写一遍就是重复 —— 之前两版都在这个位置栽过。
					react.createElement(
						"div",
						{ className: "qoduck-head" },
						react.createElement("p", { className: "qoduck-intro" }, t("settings.intro")),
					),

					// 运行状态：只读的两张卡并排。这个组里**不放任何开关** ——
					// 它只回答「现在是什么状态」，设置项归到下面的组。
					react.createElement(
						Group,
						{ title: t("settings.group.runtime"), sub: t("settings.readonly") },
						react.createElement(
							"div",
							{ className: "qoduck-stat-row" },
							react.createElement(StatCard, {
								label: t("settings.status"),
								state: state.running ? (phase === "failed" ? "error" : (phase === "waiting" || phase === "interrupted" ? "warn" : "ok")) : "",
								text: t("phase." + phase),
							}),
							react.createElement(StatCard, {
								label: t("settings.process"),
								state: state.running ? "ok" : "",
								text: state.running ? t("settings.processUp") : t("settings.processDown"),
							}),
						),
					),

					// 外观：三个开关 + 尺寸
					react.createElement(
						Group,
						{ title: t("settings.group.appearance") },
						react.createElement(
							Row,
							{ label: t("settings.enabled"), hint: t("settings.enabledHint") },
							react.createElement(Toggle, {
								label: t("settings.enabled"),
								checked: config.enabled !== false,
								onChange: (value) => patch({ enabled: value }),
							}),
						),
						react.createElement(
							Row,
							{ label: t("settings.card"), hint: t("settings.cardHint") },
							react.createElement(Toggle, {
								label: t("settings.card"),
								checked: config.showCard !== false,
								onChange: (value) => patch({ showCard: value }),
							}),
						),
						react.createElement(
							Row,
							{ label: t("settings.size"), hint: t("settings.sizeHint") },
							react.createElement(Stepper, {
								label: t("settings.size"),
								value: config.size || DEFAULT_SIZE,
								min: MIN_SIZE,
								max: MAX_SIZE,
								step: 4,
								unit: "px",
								onChange: (value) => patch({ size: value }),
							}),
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
