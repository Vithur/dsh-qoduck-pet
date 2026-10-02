/**
 * dsh-qoduck-pet — 浏览器半部。
 *
 * 这里**不渲染桌宠**。桌宠是一个独立的桌面窗口，由宿主半部拉起的 pet.ps1 承载
 * （见 lib/index.js 顶部说明）。浏览器这一侧只提供一个设置页，用来开关桌宠、
 * 调尺寸与停靠角、重置位置，并显示当前姿态与窗口进程是否在跑。
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

			const PINS = ["bottom-right", "bottom-left", "top-right", "top-left"];

			const DICT_ZH = {
				"settings.title": "Qoduck 桌宠",
				"settings.intro": "桌宠是独立于浏览器的桌面窗口（透明、置顶、无边框），关掉网页它仍在。姿态随 Agent 状态切换，可拖拽。",
				"settings.loading": "读取桌宠状态…",
				"settings.enabled": "显示桌宠",
				"settings.enabledHint": "关掉会结束窗口进程",
				"settings.tracking": "鼠标注视",
				"settings.trackingHint": "指针靠近时用 16 向帧跟随",
				"settings.card": "活动卡片",
				"settings.cardHint": "在宠物上方显示当前会话的标题、状态与停止/回复操作",
				"settings.size": "尺寸",
				"settings.pin": "停靠角",
				"settings.pinHint": "拖拽过之后以窗口自己的位置为准",
				"settings.reset": "回到默认位置",
				"settings.resetButton": "重置",
				"settings.status": "当前状态",
				"settings.process": "窗口进程",
				"settings.processUp": "运行中",
				"settings.processDown": "未运行",
				"settings.path": "状态目录",
				"phase.idle": "空闲",
				"phase.running": "正在工作",
				"phase.waiting": "需要你的操作",
				"phase.review": "结果可查看",
				"phase.failed": "执行受阻",
				"phase.interrupted": "已中断",
				"pin.bottom-right": "右下角",
				"pin.bottom-left": "左下角",
				"pin.top-right": "右上角",
				"pin.top-left": "左上角",
			};

			const DICT_EN = {
				"settings.title": "Qoduck desk pet",
				"settings.intro": "The pet is a desktop window of its own — transparent, always on top, frameless — and it keeps living after the page is closed. Its pose follows the agent state and it can be dragged.",
				"settings.loading": "Reading pet state…",
				"settings.enabled": "Show pet",
				"settings.enabledHint": "Turning it off ends the window process",
				"settings.tracking": "Eye tracking",
				"settings.trackingHint": "Follows the pointer with 16 directional frames",
				"settings.card": "Activity card",
				"settings.cardHint": "Shows the active session's title, state, and stop/reply controls above the pet",
				"settings.size": "Size",
				"settings.pin": "Dock corner",
				"settings.pinHint": "Once dragged, the window's own position wins",
				"settings.reset": "Reset position",
				"settings.resetButton": "Reset",
				"settings.status": "Current state",
				"settings.process": "Window process",
				"settings.processUp": "running",
				"settings.processDown": "not running",
				"settings.path": "State directory",
				"phase.idle": "Idle",
				"phase.running": "Working",
				"phase.waiting": "Needs your input",
				"phase.review": "Result ready",
				"phase.failed": "Run blocked",
				"phase.interrupted": "Interrupted",
				"pin.bottom-right": "Bottom right",
				"pin.bottom-left": "Bottom left",
				"pin.top-right": "Top right",
				"pin.top-left": "Top left",
			};

			// 颜色一律走宿主主题 token；只有素材本身用自带配色。
			const CSS = [
				".qoduck-settings{display:flex;flex-direction:column;gap:2px;max-width:640px;padding:4px 0 24px;}",
				".qoduck-settings-intro{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin-bottom:10px;}",
				".qoduck-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}",
				".qoduck-row:last-of-type{border-bottom:0;}",
				".qoduck-label{font-size:13px;color:var(--dsw-alias-label-primary);}",
				".qoduck-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);margin-top:2px;}",
				".qoduck-control{flex:0 0 auto;display:flex;align-items:center;gap:8px;}",
				".qoduck-value{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:52px;text-align:right;}",
				".qoduck-status{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-primary);}",
				".qoduck-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);}",
				".qoduck-dot[data-up='true']{background:var(--dsw-alias-state-success-primary);}",
				".qoduck-dot[data-phase='failed']{background:var(--dsw-alias-state-error-primary);}",
				".qoduck-dot[data-phase='waiting']{background:var(--dsw-alias-state-warn-primary);}",
				".qoduck-dot[data-phase='interrupted']{background:var(--dsw-alias-state-warn-primary);}",
				".qoduck-dot[data-phase='running']{background:var(--dsw-alias-brand-primary);}",
				".qoduck-path{font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;}",
			].join("");

			function SettingsStyles() {
				return react.createElement("style", { "data-qoduck-pet": "" }, CSS);
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
						react.createElement("div", { className: "qoduck-settings-intro" }, t("settings.loading")),
					);
				}

				const config = state.config || {};
				const phase = state.phase || "idle";

				return react.createElement(
					"div",
					{ className: "qoduck-settings" },
					react.createElement(SettingsStyles, null),
					react.createElement("div", { className: "qoduck-settings-intro" }, t("settings.intro")),

					react.createElement(
						Row,
						{ label: t("settings.status") },
						react.createElement(
							"div",
							{ className: "qoduck-status" },
							react.createElement("span", {
								className: "qoduck-dot",
								"data-up": state.running ? "true" : "false",
								"data-phase": phase,
							}),
							t("phase." + phase),
						),
					),

					react.createElement(
						Row,
						{ label: t("settings.process") },
						react.createElement(
							"div",
							{ className: "qoduck-status" },
							react.createElement("span", {
								className: "qoduck-dot",
								"data-up": state.running ? "true" : "false",
							}),
							state.running ? t("settings.processUp") : t("settings.processDown"),
						),
					),

					react.createElement(
						Row,
						{ label: t("settings.enabled"), hint: t("settings.enabledHint") },
						react.createElement(Toggle, { checked: config.enabled !== false, onChange: (value) => patch({ enabled: value }) }),
					),

					react.createElement(
						Row,
						{ label: t("settings.tracking"), hint: t("settings.trackingHint") },
						react.createElement(Toggle, { checked: config.mouseTracking !== false, onChange: (value) => patch({ mouseTracking: value }) }),
					),

					react.createElement(
						Row,
						{ label: t("settings.card"), hint: t("settings.cardHint") },
						react.createElement(Toggle, { checked: config.showCard !== false, onChange: (value) => patch({ showCard: value }) }),
					),

					react.createElement(
						Row,
						{ label: t("settings.size") },
						react.createElement("input", {
							type: "range",
							min: MIN_SIZE,
							max: MAX_SIZE,
							step: 4,
							value: config.size || DEFAULT_SIZE,
							onChange: (event) => patch({ size: Number(event.target.value) }),
							style: { width: 160, cursor: "pointer" },
						}),
						react.createElement("span", { className: "qoduck-value" }, (config.size || DEFAULT_SIZE) + " px"),
					),

					react.createElement(
						Row,
						{ label: t("settings.pin"), hint: t("settings.pinHint") },
						react.createElement(
							"select",
							{
								value: config.pin || "bottom-right",
								onChange: (event) => patch({ pin: event.target.value }),
								style: { padding: "4px 8px", borderRadius: 6, cursor: "pointer" },
							},
							PINS.map((pin) => react.createElement("option", { key: pin, value: pin }, t("pin." + pin))),
						),
					),

					react.createElement(
						Row,
						{ label: t("settings.reset") },
						react.createElement(
							"button",
							{
								type: "button",
								onClick: () => patch({ pin: "bottom-right", size: DEFAULT_SIZE }),
								style: { padding: "5px 12px", borderRadius: 6, cursor: "pointer" },
							},
							t("settings.resetButton"),
						),
					),

					state.window && react.createElement(
						"div",
						{ className: "qoduck-row" },
						react.createElement(
							"div",
							null,
							react.createElement("div", { className: "qoduck-label" }, t("settings.path")),
							react.createElement(
								"div",
								{ className: "qoduck-hint" },
								`${Math.round(state.window.left)}, ${Math.round(state.window.top)} · ${Math.round(state.window.size)} px`,
							),
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
			exports.__test = { DICT_ZH, DICT_EN, LOCALE_NS, PINS, MIN_SIZE, MAX_SIZE, DEFAULT_SIZE };
			return module.exports;
		},
	});
})();
