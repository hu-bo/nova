import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * 主题契约检查：校验 src/styles/globals.css 的 `:root` 覆盖与 @heroui/styles 的 token 契约一致。
 *
 * 防止两类反复出现的问题（HeroUI 组件的颜色由运行时 CSS 变量驱动，覆盖不完整时构建不报错，
 * 只有肉眼才能在页面上发现问题）：
 *
 * 1. 语义错位：HeroUI 把某些 token 当文字色用（如 `--muted` 是灰色文字，不是 shadcn 语义的
 *    “muted 背景”）。应用把它覆盖成近白色后，组件里 `text-muted` 的文字（toast 描述等）直接隐形。
 *    → 规则 A：组件 CSS 中以 `text-<token>` 用作文字色的 token，应用覆盖后的明度若从“深色文字”
 *      翻转为“近白”，报错。
 * 2. 派生 token 漂移：默认主题用 `color-mix()` 从基础色派生 `--<family>-soft-foreground` 等文字色。
 *    应用覆盖了 `--warning` / `--foreground` 却没覆盖派生 token 时，混合结果会变成与品牌不搭的浑浊色。
 *    → 规则 B：应用触碰了某状态家族的基础色，就必须同时显式定义该家族的 `*-soft-foreground` 文字色。
 *
 * 另有规则 C：`:root` 里定义了、但 HeroUI 与应用都没有引用的 token → 警告（防止死覆盖/拼写错误）。
 */

const appDir = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(appDir, 'package.json'));
const herouiStylesDir = dirname(require.resolve('@heroui/styles/package.json'));

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const DECLARATION = /(--[\w-]+)\s*:\s*([^;]+);/g;

/** 解析 CSS 中的自定义属性，同名保留第一次出现（默认主题里浅色块先于深色块）。 */
function parseDeclarations(css) {
  const map = new Map();
  for (const [, token, raw] of stripComments(css).matchAll(DECLARATION)) {
    if (!map.has(token)) map.set(token, raw.trim());
  }
  return map;
}

/** 解析 oklch 明度 L；`var()` 引用沿默认主题解引用最多 3 跳；color-mix 等复杂值返回 null。 */
function lightness(value, defaults) {
  let current = value;
  for (let hop = 0; hop < 3; hop += 1) {
    const ref = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(current);
    if (!ref) break;
    const next = defaults.get(ref[1]);
    if (!next) return null;
    current = next;
  }
  const match = /^oklch\(\s*([\d.]+)/.exec(current);
  return match ? Number.parseFloat(match[1]) : null;
}

// —— 读取 HeroUI 的 token 契约 ——
const themeDefaults = parseDeclarations(
  await readFile(join(herouiStylesDir, 'dist/themes/default/variables.css'), 'utf8'),
);
// theme.css 把 Tailwind 工具类映射到运行时变量：--color-muted: var(--muted)。
const themeColorMap = parseDeclarations(
  await readFile(join(herouiStylesDir, 'dist/themes/shared/theme.css'), 'utf8'),
);
const colorToRuntime = new Map();
for (const [key, value] of themeColorMap) {
  const match = /^--color-([\w-]+)$/.exec(key);
  const ref = /var\(\s*(--[\w-]+)/.exec(value);
  if (match && ref) colorToRuntime.set(match[1], ref[1]);
}

// 组件层（BEM CSS + tailwind-variants 样式）实际消费的文字色 token 与 var() 引用。
const textRoleTokens = new Set();
const referencedByHeroUI = new Set(themeDefaults.keys());
const componentDir = join(herouiStylesDir, 'dist/components');
for (const entry of await readdir(componentDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(css|js)$/.test(entry.name)) continue;
  const content = stripComments(await readFile(join(componentDir, entry.name), 'utf8'));
  for (const [, name] of content.matchAll(/(?<![\w-])text-([\w-]+)/g)) {
    const runtime = colorToRuntime.get(name);
    if (runtime) textRoleTokens.add(runtime);
  }
  for (const [, token] of content.matchAll(/var\(\s*(--[\w-]+)/g)) referencedByHeroUI.add(token);
}

// —— 读取应用的覆盖与映射 ——
const globals = stripComments(await readFile(join(appDir, 'src/styles/globals.css'), 'utf8'));
const rootMatch = /:root\s*\{([^}]*)\}/.exec(globals);
if (!rootMatch) throw new Error('globals.css 中找不到 :root 主题覆盖块');
const appOverrides = parseDeclarations(rootMatch[1]);
const appThemeRefs = new Set();
for (const [, block] of globals.matchAll(/@theme[^{]*\{([^}]*)\}/g)) {
  for (const [, , value] of stripComments(block).matchAll(DECLARATION)) {
    for (const [, token] of value.matchAll(/var\(\s*(--[\w-]+)/g)) appThemeRefs.add(token);
  }
}

const errors = [];
const warnings = [];

// 规则 A：文字色 token 被覆盖成近白 → 组件文字不可见。
for (const token of textRoleTokens) {
  if (!appOverrides.has(token)) continue;
  const defaultL = lightness(themeDefaults.get(token), themeDefaults);
  const appL = lightness(appOverrides.get(token), themeDefaults);
  if (defaultL !== null && appL !== null && defaultL < 0.6 && appL > 0.7) {
    errors.push(
      `规则A ${token}: HeroUI 将其用作文字色（默认明度 ${defaultL}），应用覆盖为明度 ${appL} 的近白色，` +
        '组件文字会不可见。文字灰请用该 token，浅色背景请另起 token 名。',
    );
  }
}

// 规则 B：触碰状态基础色就必须补齐派生文字色 *-soft-foreground。
for (const family of ['accent', 'success', 'warning', 'danger']) {
  const derived = `--${family}-soft-foreground`;
  const defaultDerived = themeDefaults.get(derived);
  if (!defaultDerived || !defaultDerived.includes('color-mix')) continue;
  const touchedBase =
    appOverrides.has(`--${family}`) ||
    appOverrides.has(`--${family}-foreground`) ||
    appOverrides.has('--foreground');
  if (touchedBase && !appOverrides.has(derived)) {
    errors.push(
      `规则B ${derived}: 默认主题用 color-mix 从 --${family}/--foreground 派生该文字色；` +
        `应用覆盖了基础色却没有覆盖 ${derived}，组件（toast/alert 变体等）会渲染出浑浊的偏移色。请在 :root 显式定义。`,
    );
  }
}

// 规则 C：死覆盖。
for (const token of appOverrides.keys()) {
  const referenced =
    referencedByHeroUI.has(token) ||
    appThemeRefs.has(token) ||
    [...appOverrides.values()].some((value) => value.includes(`var(${token}`));
  if (!referenced) {
    warnings.push(
      `规则C ${token}: :root 中定义，但 HeroUI 组件与应用样式均未引用（拼写错误或死覆盖？）`,
    );
  }
}

for (const warning of warnings) console.warn(`[theme] ⚠ ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`[theme] ✗ ${error}`);
  throw new Error(
    `主题契约检查失败（${errors.length} 项）。见 apps/nova-client/scripts/check-theme.mjs 注释。`,
  );
}
console.log(
  `[theme] 主题契约通过：${appOverrides.size} 个 :root 覆盖，${textRoleTokens.size} 个文字色 token，` +
    `${warnings.length} 个警告`,
);
