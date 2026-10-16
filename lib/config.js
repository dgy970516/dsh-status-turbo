/**
 * dsh-status-turbo — 本插件条目 `Config` 的 schema 与「用时现取」的配置视图。
 *
 * 为什么单独一层：DSH 的设置命名空间只能由**插件条目自己的 `Config`** 产生（旧
 * `settings.register(ns, schema)` / `settings.get(ns)` 已从设置服务移除），而 schemastery 只在装好的
 * profile 里解析得到 —— 所以本模块把 `z` 当参数注入，自己零 import，仓库工作树里也能被
 * `node --test` 直接加载。
 */

/**
 * 本插件的条目 `Config`（DSH ≥0.1.7 里，**插件条目自己的 Config schema 就是它的设置存储**，
 * 且描述函数只认带 `toJSON` 的 schemastery 实例）。
 *
 * **每个字段都标 `volatile`（0.16.0 起）**。理由有两条，都在 `dsh-settings` 的实现里：
 * 设置页只把 volatile 子树投成字段（`volatileForm` 丢掉没有 volatile 的整棵子树 —— 非 volatile
 * 字段连显示都不显示），而也只有 volatile 字段能被热写（loader 检出"只改了 volatile 字段"后
 * `_commitVolatile()` 就地更新引用并发 `loader/volatile-update`，不重挂插件）。
 *
 * 代价：解析结果是冻结引用 `{ get() }`，读之前必须 `unwrapVolatile` 且**必须在用时现取** ——
 * `lib/index.js` 的 `resolveConfig` 因此返回 getter 视图（`liveConfig`），而不是挂载时的快照。
 *
 * `DEFAULT_CONFIG` 里今天只有布尔 / 数字 / 字符串 / 字符串数组四种；其他类型会被跳过，而跳过的键
 * 仍由 `liveConfig` 的 `DEFAULT_CONFIG` 兜底，所以不会静默取空。真出现新类型时在这里补一条
 * 显式分支，别让默认值悄悄回到旧来源。
 *
 * @param {object} z schemastery 命名空间对象。
 * @param {object} defaults 默认值表（`lib/state.js` 的 `DEFAULT_CONFIG`，默认值的唯一来源）。
 * @returns {object} 描述整个插件配置的 schema。
 */
export function turboConfigSchema(z, defaults) {
  const fields = {}
  for (const key of Object.keys(defaults)) {
    const value = defaults[key]
    let field = null
    if (typeof value === 'boolean') field = z.boolean().default(value)
    else if (typeof value === 'number') field = z.natural().default(value)
    else if (typeof value === 'string') field = z.string().default(value)
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      field = z.array(z.string()).default(value)
    }
    if (field !== null) fields[key] = field.volatile()
  }
  return z.object(fields)
}

/**
 * 造一个「用时现取」的配置视图：每个属性都是 getter，读的是宿主配置上那个 volatile 引用**此刻**的
 * `get()`，只有取不到值时才回落默认值。
 *
 * volatile 引用对象在插件生命周期内是稳定的（loader 的 `_commitVolatile()` 原地更新它，而不是换一
 * 个对象），所以这个视图对象挂载时造一次即可，此后每次都反映最新设置 —— 这正是"设置页改了立刻
 * 生效"所需的唯一条件。视图本身的身份不变，读它的分支（轮换阈值、上下文裁剪、溢出落盘）无需改动。
 *
 * @param {object} [config] 宿主传给插件的配置（可能缺失，也可能不是对象）。
 * @param {object} defaults 默认值表（`DEFAULT_CONFIG`）。
 * @returns {object} 属性为 getter 的配置视图。
 */
export function liveConfig(config, defaults) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const view = {}
  for (const key of Object.keys(defaults)) {
    Object.defineProperty(view, key, {
      enumerable: true,
      get() {
        const raw = unwrapVolatile(source[key])
        return raw === undefined || raw === null ? defaults[key] : raw
      },
    })
  }
  return view
}

/**
 * 解引用 volatile 字段的解析结果。
 *
 * schemastery 把标记了 `volatile` 的字段解析成冻结引用（`{ get() }`，见 cosmokit 的 `isVolatile`），
 * 当普通值用会静默取错。只认「有 `get` 方法的非数组对象」，是数组或普通对象原样返回。
 *
 * @param {unknown} value 解析后的字段值。
 * @returns {unknown} 解引用后的普通值。
 */
export function unwrapVolatile(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const get = value.get
  if (typeof get !== 'function') return value
  try {
    return get.call(value)
  } catch (error) {
    return value
  }
}
