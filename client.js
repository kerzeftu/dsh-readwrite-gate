/**
 * Browser half of the access-permission bundle.
 *
 * It takes over the shipped composer permission control (`conversation.input.permission`)
 * so the composer keeps exactly one permission seat — now covering the two added
 * access levels as well, each mode carrying its own symbol and type treatment.
 * The switch still goes through the Host `/permission` command, and the shipped
 * catalog Remote plus the `permissions` projection stay the only sources of
 * options and current value. Authorization dialogs are rendered by the
 * deployment's question panel, so this half owns the level control, not the dialog.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-access-permission',
  factory(require) {
    const React = require('react')
    // Optional: without the DOM renderer the floating surfaces stay in tree.
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }
    const h = React.createElement
    const NS = 'access.permission'

    /**
     * How one preset presents itself. Only these three fields differ per mode:
     * the symbol, the accent colour the label is drawn in, and a one-line note
     * stating what the mode means (it heads the mode's menu row and the trigger's
     * tooltip). Every level gets its own accent — a shipped alias token where one
     * matches the requested colour, the plugin's own palette pair for the two
     * yellows — so the mode reads at a glance.
     *
     * The type treatment is deliberately NOT per-mode — see {@link CONTROL_TYPE}.
     */
    const MODES = {
      'no-access': {
        symbol: 'noAccess',
        tone: 'none',
        accent: 'var(--dsw-alias-state-success-primary)',
        note: '不可查看、不可修改任何文件',
      },
      'workspace-access': {
        // The symbol swap with workspace-write is deliberate: this rung is the
        // stricter "read and write inside" one, so it wears the guarded glyph.
        symbol: 'workspaceWrite',
        tone: 'workspace',
        // The neutral end of the set: everything it grants stays inside the
        // workspace and the temp area, so it wears the theme's own brand ink
        // (near-white on dark, near-black on light).
        accent: 'var(--dsw-alias-brand-primary)',
        note: '工作区与 /tmp 内可查看可修改；其他区外读取需授权',
      },
      'read-only': {
        symbol: 'readOnly',
        tone: 'other',
        // The fluorescent yellow of the pair; the paler one is workspace-write's.
        accent: 'var(--ap-level-read, #eeff00)',
        note: '任意路径可查看；禁止修改',
      },
      'workspace-write': {
        // The house glyph, swapped with workspace-access: this rung is the
        // everyday "work inside the workspace" one.
        symbol: 'workspace',
        tone: 'other',
        // The paler yellow of the pair, with a hex fallback for a missing style.
        accent: 'var(--ap-level-write, #f5e3a3)',
        note: '任意路径可查看；修改限工作区与 /tmp 内',
      },
      'danger-full-access': {
        symbol: 'full',
        tone: 'full',
        accent: 'var(--dsw-alias-state-error-primary)',
        note: '任意路径可查看可修改，不再询问',
      },
    }

    /**
     * The single type treatment shared by every mode and by both composer
     * controls. These are the shipped permission control's own metrics, so this
     * plugin's controls sit in the composer row exactly like the one they
     * accompany: when the level changes only the accent colour and the symbol
     * change, never the geometry, so the row never reflows.
     */
    /**
     * The extra-readable-files control wears the Windows-style folder rather than
     * a theme-tinted glyph: a solid two-tone yellow, identical in both themes and
     * on every platform. The mode control next to it keeps its per-mode accent.
     */
    const FOLDER = { back: '#e8a33c', front: '#ffc94c' }

    /**
     * The level ladder needs two yellows ("light" for read-only, the plain one
     * for view-inside-workspace) and the theme ships exactly one amber alias
     * (`--dsw-alias-state-warn-primary`) plus the state colours — no yellow pair.
     * A single fixed hex would be illegible in one of the two palettes, so the
     * pair ships with the plugin as body-scoped custom properties: `body` carries
     * the light values and the theme presenter's `body[data-ds-dark-theme]`
     * attribute (ui-layout's ThemePresenter) selects the dark ones, which is the
     * same switch the shipped aliases use. Consumers keep their own fallback hex,
     * so a missing style element still paints a yellow.
     */
    const LEVEL_PALETTE = {
      light: { read: '#7a8a00', write: '#c9a227' },
      dark: { read: '#eeff00', write: '#f5e3a3' },
    }
    const PALETTE_STYLE_ID = 'dsh-access-permission-level-palette'
    // Hover and focus fills cannot be expressed with inline styles, and the
    // shipped surfaces get theirs from the primitive stylesheets, so the few
    // rules this plugin's own rows and buttons need ride in the same element.
    const SURFACE_CSS =
      '.ap-level-row:hover:not(:disabled),.ap-level-row:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}' +
      '.ap-level-row:disabled{opacity:.4;cursor:not-allowed}' +
      '.ap-dialog-close:hover:not(:disabled),.ap-dialog-cancel:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.ap-dialog-go:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}'
    const PALETTE_CSS =
      `body{--ap-level-read:${LEVEL_PALETTE.light.read};--ap-level-write:${LEVEL_PALETTE.light.write}}` +
      `body[data-ds-dark-theme]{--ap-level-read:${LEVEL_PALETTE.dark.read};--ap-level-write:${LEVEL_PALETTE.dark.write}}` +
      SURFACE_CSS

    // The shipped menu material (`Menu.module.css` + `MenuSurface.module.css`):
    // a translucent fill over a blurred backdrop, the prominent elevation and the
    // large card radius. Reading these tokens instead of a flat `bg-overlay` is
    // what keeps the plugin's popups from looking like a grey box beside the
    // host's own menus.
    const MENU_SURFACE = {
      border: 0,
      borderRadius: 'var(--dsw-radius-lg, 12px)',
      background: 'var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-2))',
      backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
      boxShadow: 'var(--dsw-elevation-prominent, var(--dsw-shadow-lv3, 0 3px 8px rgba(0, 0, 0, 0.12)))',
      '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
    }

    /**
     * Publish the level palette into the page once. Kept out of React so the
     * variables exist before the seat renders, and idempotent per style element
     * so a re-applied fiber reuses the same node instead of stacking tags.
     */
    function installLevelPalette() {
      if (typeof document === 'undefined') return
      const selector = `style[data-plugin-css="${PALETTE_STYLE_ID}"]`
      let element = document.querySelector(selector)
      if (element === null) {
        element = document.createElement('style')
        element.setAttribute('data-plugin-css', PALETTE_STYLE_ID)
        const parent = document.head ?? document.documentElement
        if (parent === null || parent === undefined) return
        parent.appendChild(element)
      }
      element.textContent = PALETTE_CSS
    }

    const CONTROL_TYPE = {
      size: 13,
      weight: 500,
      lineHeight: '20px',
      height: 28,
      gap: 4,
      padding: '0 4px 0 8px',
      radius: 'var(--dsw-radius-sm)',
    }

    /**
     * The presets this bundle and the shipped table are known to offer. Used only
     * while the catalog read has not settled or has failed, so the seat stays
     * usable; a settled catalog always wins for the values it lists.
     */
    const FALLBACK_OPTIONS = [
      { value: 'no-access', name: '无权限', description: '不可查看、不可修改任何文件。' },
      { value: 'workspace-access', name: '工作区内读写', description: '可查看和修改工作区与 /tmp 内的文件；其他区外读取会弹出授权页，其他区外修改仍会被拒绝。' },
      { value: 'read-only', name: '只读', description: '可查看任意路径的文件；任何修改都会被拒绝。' },
      { value: 'workspace-write', name: '工作区内编辑', description: '可查看任意路径的文件；修改限制在工作区与 /tmp 内。' },
      { value: 'danger-full-access', name: '完全访问', description: '可查看和修改任意路径的文件。' },
    ]

    /** Symbols drawn in the host's icon language; stroke inherits currentColor. */
    const SYMBOLS = {
      readOnly: [
        ['circle', { cx: 8, cy: 8, r: 5.4, strokeWidth: 1.5 }],
        ['path', { d: 'M5.4 8h5.2', strokeWidth: 1.5, strokeLinecap: 'round' }],
      ],
      workspaceWrite: [
        ['path', { d: 'M8 1.8 3.2 3.9v3.9c0 2.9 2 5.3 4.8 6.4 2.8-1.1 4.8-3.5 4.8-6.4V3.9L8 1.8Z', strokeWidth: 1.4, strokeLinejoin: 'round' }],
        ['path', { d: 'M6 8.1 7.5 9.6 10.2 6.6', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }],
      ],
      full: [
        ['path', { d: 'M8 1.8 3.2 3.9v3.9c0 2.9 2 5.3 4.8 6.4 2.8-1.1 4.8-3.5 4.8-6.4V3.9L8 1.8Z', strokeWidth: 1.4, strokeLinejoin: 'round' }],
        ['path', { d: 'M6.2 6.6h3.6v3.6H6.2z', strokeWidth: 1.4, strokeLinejoin: 'round' }],
      ],
      noAccess: [
        ['circle', { cx: 8, cy: 8, r: 5.8, strokeWidth: 1.5 }],
        ['path', { d: 'M4.4 11.6 11.6 4.4', strokeWidth: 1.5, strokeLinecap: 'round' }],
      ],
      workspace: [
        ['path', { d: 'M2.4 13.2V7.1l5.6-4.3 5.6 4.3v6.1H2.4Z', strokeWidth: 1.4, strokeLinejoin: 'round' }],
        ['path', { d: 'M6.2 13.2V9.4h3.6v3.8', strokeWidth: 1.4, strokeLinejoin: 'round' }],
      ],
      // The extra-readable-files control draws the Windows-style folder the user
      // asked for: two solid filled shapes (darker tab/back, brighter front) and
      // no stroke, so it keeps its own colours instead of a theme accent.
      readable: [
        ['path', { d: 'M2.8 5a1 1 0 0 1 1-1h2.5a1 1 0 0 1 .8.4l1 1.2h4.5a1 1 0 0 1 1 1v1.3H2.8Z', fill: FOLDER.back, stroke: 'none' }],
        ['path', { d: 'M2.5 7h11a.9.9 0 0 1 .9.9v3.8a1.4 1.4 0 0 1-1.4 1.4H2.9a1.4 1.4 0 0 1-1.4-1.4V7.9a.9.9 0 0 1 .9-.9Z', fill: FOLDER.front, stroke: 'none' }],
      ],
      chevron: [
        ['path', { d: 'M4.2 6.4 8 10.2l3.8-3.8', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }],
      ],
      close: [
        ['path', { d: 'M4.6 4.6 11.4 11.4', strokeWidth: 1.5, strokeLinecap: 'round' }],
        ['path', { d: 'M11.4 4.6 4.6 11.4', strokeWidth: 1.5, strokeLinecap: 'round' }],
      ],
      // The dialog's risk mark, drawn in the error colour like the shipped
      // RiskConfirmation's warning icon.
      warning: [
        ['path', { d: 'M8 2.6 14.2 13.4H1.8L8 2.6Z', strokeWidth: 1.4, strokeLinejoin: 'round' }],
        ['path', { d: 'M8 6.6v3.2', strokeWidth: 1.4, strokeLinecap: 'round' }],
        ['circle', { cx: 8, cy: 11.6, r: 0.75, fill: 'currentColor', stroke: 'none' }],
      ],
    }

    const zh = {
      label: '访问权限',
      glyph: '权限图标',
      'full.label': '完全访问',
      'full.description': '可读取和修改任意路径的文件。',
      'workspace.label': '工作区内读写',
      'workspace.description': '可查看和修改工作区与 /tmp 内的文件；其他区外读取会弹出授权页，其他区外修改仍会被拒绝。',
      'none.label': '无权限',
      'none.description': '不可查看、不可修改任何文件。',
      title: '本对话的访问权限',
      current: '当前',
      switchFailed: '切换失败：',
      restartHint: '若提示未知预设，说明运行中的进程还没载入新增的权限类型，重启 Harness 后即可切换。',
      confirmTitle: '切换到完全访问？',
      confirmDescription: '完全访问下模型可以读取和修改任意路径的文件，不再逐一询问。',
      confirmAcknowledge: '我了解风险，并自行承担后果',
      confirmEnable: '切换',
      close: '关闭',
      cancel: '取消',
      // The extra-readable-files feature. Every key below is read by a component
      // in this file; a key that is absent renders as its own literal name,
      // because the locale service falls back to the key itself.
      allowEntry: '额外可读写文件',
      allowTitle: '额外可读写文件',
      allowHint: '上面一框是本对话额外可读的路径，下面一框是额外可写的路径：写权限自带读，所以可写路径也会出现在读框里。以 / 结尾的行是目录，覆盖其下全部文件与子目录。读框的 ✕ 会整行移除（读写一起来的会一起撤销），写框的 ✕ 只撤销写；撤销后再次访问会重新询问。',
      readBoxTitle: '额外可读文件',
      writeBoxTitle: '额外可写文件',
      readBoxEmpty: '还没有额外可读的文件或目录。',
      writeBoxEmpty: '还没有额外可写的文件或目录。',
      allowPlaceholder: '输入文件或目录的完整路径（Windows 盘符写法如 C:\\Users\\me 也可）',
      confirm: '添加',
      enterPath: '手动输入路径',
      pickDirectory: '选择目录…',
      pickFallback: '本机没有可用的系统目录对话框，已切换到内置浏览：',
      browseTitle: '选择目录',
      browseCrumbHome: '主目录',
      browseUp: '上一级',
      browseChoose: '选择这个目录',
      browseEmpty: '此目录下没有子目录',
      browseLoading: '正在读取…',
      browseTruncated: '目录项过多，仅显示前一部分',
      browseFailed: '无法列出目录内容',
      browsePlaces: '快捷位置',
      browseWslRoot: 'WSL 根目录',
      removeImpliedRead: '读由写隐含：这一下会连同写权限一起移除',
      // These two are read through the locale binder rather than the t helper,
      // so a scan that only looks for the t helper misses them — keep them here.
      addAllowed: '额外可读文件',
      addAllowedHint: '添加仅允许读取的文件或目录',
      remove: '移除',
    }

    const en = {
      label: 'Access',
      glyph: 'Access icon',
      'full.label': 'Full access',
      'full.description': 'View and modify files anywhere.',
      'workspace.label': 'Read and write inside workspace',
      'workspace.description': 'View and modify files inside the workspace and /tmp; other outside reads ask for authorization and other outside modifications are still refused.',
      'none.label': 'No access',
      'none.description': 'Files can be neither viewed nor modified.',
      title: 'Access level of this conversation',
      current: 'current',
      switchFailed: 'Switch failed: ',
      restartHint: 'An unknown-preset error means the running process has not loaded the added access levels yet; restart the Harness and the switch works.',
      confirmTitle: 'Switch to full access?',
      confirmDescription: 'Under full access the model reads and modifies files anywhere without asking each time.',
      confirmAcknowledge: 'I understand the risk and accept it',
      confirmEnable: 'Switch',
      close: 'Close',
      cancel: 'Cancel',
      // Mirrors the Chinese dictionary key for key; see the note there.
      allowEntry: 'Extra readable and writable files',
      allowTitle: 'Extra readable and writable files',
      allowHint: 'The upper box lists the paths this conversation may also read, the lower box those it may also write: a write always includes its read, so writable paths appear in the read box too. A row ending in / is a folder and covers every file and subfolder inside it. The read box ✕ removes the whole row (a write is revoked with its read); the write box ✕ revokes only the write, and the next access asks again.',
      readBoxTitle: 'Extra readable files',
      writeBoxTitle: 'Extra writable files',
      readBoxEmpty: 'No extra readable files or folders yet.',
      writeBoxEmpty: 'No extra writable files or folders yet.',
      allowPlaceholder: 'Full path of a file or folder (a Windows path such as C:\\Users\\me works too)',
      confirm: 'Add',
      enterPath: 'Type a path',
      pickDirectory: 'Choose a folder…',
      pickFallback: 'No system folder dialog is available on this machine; switched to the built-in browser: ',
      browseTitle: 'Choose a folder',
      browseCrumbHome: 'Home',
      browseUp: 'Up',
      browseChoose: 'Choose this folder',
      browseEmpty: 'No subfolders here',
      browseLoading: 'Reading…',
      browseTruncated: 'Too many entries; only the first part is shown',
      browseFailed: 'Could not list this folder',
      browsePlaces: 'Quick places',
      browseWslRoot: 'WSL root',
      removeImpliedRead: 'Read is implied by write: this also removes the write permission',
      remove: 'Remove',
      // See the note in the Chinese dictionary: these are read through the
      // locale binder, so a scan for the t helper alone misses them.
      addAllowed: 'Extra readable files',
      addAllowedHint: 'Add a file or folder that stays readable',
    }

    /**
     * Draw one mode symbol.
     * @param name - symbol name from {@link MODES}.
     * @param size - pixel size of the square glyph.
     * @returns The inline SVG element.
     */
    function ModeSymbol(name, size = 14) {
      const parts = SYMBOLS[name] ?? SYMBOLS.readOnly
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block', flex: '0 0 auto' },
      }, parts.map(([tag, attributes], index) => h(tag, { key: index, ...attributes })))
    }

    /**
     * Mount one floating surface on the document body so the composer's
     * clipping container cannot cut it off and it cannot cover the page as an
     * in-flow overlay. Falls back to the in-tree element when React offers no
     * portal in this runtime.
     * @param element - the element to float.
     * @returns the portal element, or the original element.
     */
    function portal(element) {
      if (element === null || element === undefined) return null
      if (typeof document === 'undefined' || document.body === null || document.body === undefined) return element
      return ReactDOM !== null && typeof ReactDOM.createPortal === 'function'
        ? ReactDOM.createPortal(element, document.body)
        : element
    }

    /**
     * A minimal observable snapshot source. The slot hook contract needs only
     * `getSnapshot` and `subscribe`, so no store package is imported.
     * @param initial - initial value.
     * @returns the source.
     */
    function createSource(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          if (next === value) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * Whether one permission preset means a restricted access level, which is
     * when the readable-file list matters.
     * @param value - preset name from the `permissions` projection.
     * @returns whether the level restricts reading.
     */
    function restrictedPreset(value) {
      const mode = MODES[value]
      return mode !== undefined && mode.tone !== 'other' ? mode.tone !== 'full' : value !== 'danger-full-access'
    }

    /**
     * Read the extra-path rows out of one `/access-allow` reply. The host appends
     * a `[allow: …]` marker whose fields are the percent-encoded path, a bar, then
     * the families it covers (`r`, `w`, `rw`) and a `d` when the entry is a
     * directory; fields are separated by a unit separator so a path containing
     * spaces or bars stays one field. A legacy field without a bar is a read-only
     * entry.
     * @param text - the command's output text.
     * @returns the rows, or null when the reply carried no marker.
     */
    function parseAllowMarker(text) {
      if (typeof text !== 'string') return null
      const match = /\[allow:\s*([^\]]*)\]/.exec(text)
      if (match === null) return null
      const body = match[1].trim()
      if (body === '') return []
      return body.split('\u0001').map((field) => {
        const separator = field.indexOf('|')
        const raw = separator === -1 ? field : field.slice(0, separator)
        const flags = separator === -1 ? 'r' : field.slice(separator + 1)
        let path = raw
        try {
          path = decodeURIComponent(raw)
        } catch {
          path = raw
        }
        const write = flags.includes('w')
        // A write is also a read: the host stores it that way, and the read box
        // lists it even when the marker carries no `r` bit.
        const read = flags.includes('r') || write
        return { path, read, readable: read, write, directory: flags.includes('d') }
      }).filter((row) => row.path !== '')
    }

    /**
     * The in-app folder browser, asked for from outside the composer control.
     *
     * The add menu registers on its own and cannot reach a mounted control's
     * React state, so it asks through this set and the control mounted for that
     * session opens its browser. One watcher throwing must not stop the others;
     * normally there is exactly one.
     */
    const browserWatchers = new Set()

    /**
     * Ask the control mounted for one session to open its folder browser.
     * @param sessionId - the session the browser belongs to.
     * @param family - which box the chosen folder is added to.
     * @returns nothing.
     */
    function requestBrowser(sessionId, family) {
      if (browserWatchers.size === 0) {
        console.error('[access-permission] no mounted control to open the folder browser')
        return
      }
      for (const watcher of [...browserWatchers]) {
        try {
          watcher(sessionId, family)
        } catch (cause) {
          console.error('[access-permission] folder browser request failed:', cause)
        }
      }
    }

    /**
     * Render one readable-file entry list with its remove and add actions.
     * @param props - session slot props plus the allowlist actions.
     * @returns The entry control, or null outside restricted levels.
     */
    function AllowControl(props) {
      const selection = props.useProjection('permissions')
      const [open, setOpen] = React.useState(false)
      const [entries, setEntries] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [adding, setAdding] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [anchor, setAnchor] = React.useState({ left: 0, bottom: 0 })
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const browserRef = React.useRef(null)
      // The add menu reaches the chooser through this ref; the chooser itself is
      // defined further down, and hooks may not depend on an early return.
      const chooseRef = React.useRef(null)
      const [hovered, setHovered] = React.useState(false)
      // Appended after every existing state, not inserted: the checks poke state
      // by slot index, so the earlier indices have to keep their meaning.
      const [addingFamily, setAddingFamily] = React.useState(null)
      // The in-app folder browser: null while closed, otherwise the family it is
      // adding to plus its listing state. Appended for the same index reason.
      const [browse, setBrowse] = React.useState(null)
      // Quick jumps shown above the breadcrumbs: home, the WSL root and one row
      // per Windows drive mounted under /mnt. The host offers no "list mounts"
      // call, so the drives are read as the children of /mnt, once per open.
      const [places, setPlaces] = React.useState(null)
      const currentValue = typeof selection?.currentValue === 'string' ? selection.currentValue : undefined
      const restricted = currentValue !== undefined && restrictedPreset(currentValue)
      // The count follows the authorization dialog, not the click: the host records
      // a grant while the question is being answered, and the shipped
      // `userQuestions` projection settles at that moment. Without it the number
      // stayed stale until the panel was opened. Only that one signal is used: it
      // fires once per answered question, where a stats-style projection would
      // re-read the host on every streamed event.
      const settledQuestions = props.useProjection('userQuestions', (view) => (Array.isArray(view?.settled) ? view.settled.length : 0))
      // The add menu cannot reach this component's state, so it asks through the
      // module-level watcher set. The callback goes through the ref because the
      // chooser is defined after this hook and hook order must not change.
      React.useEffect(() => {
        const watcher = (sessionId, family) => {
          if (typeof props.sessionId === 'string' && props.sessionId !== '' && sessionId !== props.sessionId) return
          if (chooseRef.current !== null) chooseRef.current(family === 'write' ? 'write' : 'read')
        }
        browserWatchers.add(watcher)
        return () => { browserWatchers.delete(watcher) }
      }, [props.sessionId])

      /**
       * Re-read the allowlist from the host.
       * @returns the loaded entries.
       */
      const refresh = () => Promise.resolve(props.listAllowed())
        .then((result) => {
          if (result !== null && Array.isArray(result.entries)) {
            setEntries(result.entries)
            setError(result.failure ?? null)
          } else if (typeof result === 'string') {
            setError(result)
          }
          return result
        })
        .catch((cause) => {
          setError(cause instanceof Error ? cause.message : String(cause))
          return null
        })

      React.useEffect(() => {
        if (currentValue === undefined) return undefined
        let alive = true
        Promise.resolve(refresh()).then(() => { if (!alive) setEntries(null) })
        return () => { alive = false }
      }, [restricted, currentValue, settledQuestions])

      React.useEffect(() => {
        if (!open && browse === null) return undefined
        const inside = (target) => (rootRef.current !== null && rootRef.current.contains(target))
          || (panelRef.current !== null && panelRef.current.contains(target))
          || (browserRef.current !== null && browserRef.current.contains(target))
        const close = (event) => {
          if (event !== undefined && inside(event.target)) return
          setOpen(false)
          setAdding(false)
          setDraft('')
          setBrowse(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('pointerdown', close, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', () => close(), { once: true })
        return () => {
          document.removeEventListener('pointerdown', close, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open, browse === null])

      // Present whenever the session has a permission capability. It is dimmed
      // rather than hidden outside restricted levels: a control that disappears
      // by mode is indistinguishable from a control that failed to render.
      if (currentValue === undefined) return null
      const list = entries ?? []

      /**
       * The trigger's viewport rect as a floating-panel anchor, or null when the
       * trigger has not been laid out yet (the add-menu path can ask before any
       * panel has opened).
       * @returns `{ left, bottom }` in viewport pixels, or null.
       */
      const triggerAnchor = () => {
        if (triggerRef.current === null || typeof triggerRef.current.getBoundingClientRect !== 'function') return null
        const rect = triggerRef.current.getBoundingClientRect()
        if (rect.width <= 0 && rect.height <= 0) return null
        const width = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024
        const height = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768
        return {
          left: Math.max(8, Math.min(rect.left - 220, width - 360)),
          bottom: Math.max(8, height - rect.bottom + 6),
        }
      }

      const openPanel = () => {
        if (open) {
          setOpen(false)
          return
        }
        const position = triggerAnchor()
        if (position !== null) setAnchor(position)
        setOpen(true)
        refresh()
      }

      const startAdding = (family) => {
        setAdding(true)
        setAddingFamily(family)
        setDraft('')
      }

      const add = (path, family) => {
        if (typeof path !== 'string' || path.trim() === '') return
        setError(null)
        Promise.resolve(props.addAllowed(path.trim(), family))
          .then((failure) => {
            if (typeof failure === 'string' && failure !== '') setError(failure)
            setAdding(false)
            setDraft('')
            return refresh()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      }

      const remove = (path, family) => {
        setError(null)
        Promise.resolve(props.removeAllowed(path, family))
          .then((failure) => {
            if (typeof failure === 'string' && failure !== '') setError(failure)
            return refresh()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      }

      /**
       * Read one directory level into the browser.
       * @param family - which box the browser is adding to.
       * @param path - directory to list, or null for the backend's default
       *   (the home directory).
       * @returns nothing.
       */
      const loadListing = (family, path) => {
        Promise.resolve(path === null ? props.listDirectory(null) : props.listDirectory(path))
          .then((result) => {
            if (result !== null && typeof result === 'object' && result.listing !== undefined) {
              // Merge instead of replacing: the browser is positioned from the
              // anchor captured when it opened, and a replacement object without
              // that field crashes the next render (the slot then drops the whole
              // control, which looks like the panel simply vanishing).
              setBrowse((state) => (state === null ? state : {
                ...state,
                family,
                listing: result.listing,
                busy: false,
                failure: result.failure ?? null,
                note: null,
              }))
              return
            }
            setBrowse((state) => (state === null ? state : {
              ...state,
              busy: false,
              failure: typeof result === 'string' && result !== '' ? result : props.t('browseFailed'),
            }))
          })
          .catch((cause) => {
            setBrowse((state) => (state === null ? state : {
              ...state,
              busy: false,
              failure: cause instanceof Error ? cause.message : String(cause),
            }))
          })
      }

      /**
       * Read the drive rows offered above the breadcrumbs.
       *
       * Windows drives are ordinary directories under /mnt in WSL, so one
       * listing is enough; anything that is not a single-letter drive (the /mnt
       * housekeeping directories) is left out. A failed read simply offers no
       * drive rows: the browser is still usable through the breadcrumbs.
       * @returns nothing.
       */
      const loadPlaces = () => {
        Promise.resolve(props.listDirectory('/mnt'))
          .then((result) => {
            const listing = result !== null && typeof result === 'object' ? result.listing : undefined
            if (listing === undefined || listing === null || !Array.isArray(listing.entries)) return
            setPlaces(listing.entries
              .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.name === 'string' && /^[A-Za-z]$/.test(entry.name) && typeof entry.path === 'string' && entry.path !== '')
              .map((entry) => ({ label: entry.name.toUpperCase() + ':', path: entry.path })))
          })
          .catch(() => {})
      }

      /**
       * Open the folder chooser for one box.
       *
       * The system dialog is tried first because it is the shipped interaction
       * where one exists. It does not exist everywhere: `pick` is served only by
       * a native backend, and on a machine where the host resolved the browse
       * backend (no zenity/kdialog) the call answers with a capability error.
       * That is not a user error, so the in-app browser opens instead and adds
       * the folder itself.
       * @param family - which box the chosen folder is added to.
       * @returns nothing.
       */
      const chooseDirectory = (family) => {
        setError(null)
        // The add menu can ask before the panel ever opened, so the browser falls
        // back to the last known anchor when the trigger has no layout yet.
        const at = triggerAnchor() ?? anchor
        Promise.resolve(props.pickDirectory())
          .then((path) => {
            // A null answer is a dismissed dialog, not a missing backend: do not
            // open a second chooser over it.
            if (path === null || path === undefined) return
            if (typeof path === 'string' && path !== '') {
              add(path, family)
              return
            }
            setBrowse({ family, listing: null, busy: true, failure: null, note: props.t('pickFallback'), anchor: at })
            loadPlaces()
            loadListing(family, null)
          })
          .catch((cause) => {
            const detail = cause instanceof Error ? cause.message : String(cause)
            setBrowse({
              family,
              listing: null,
              busy: true,
              failure: null,
              note: `${props.t('pickFallback')}${detail}`,
              anchor: at,
            })
            loadPlaces()
            loadListing(family, null)
          })
      }
      chooseRef.current = chooseDirectory

      // Two stacked boxes, as the control's own name promises: what this
      // conversation may also read, and what it may also write. A write always
      // implies its read, so the read box lists writes too; the write box lists
      // writes only. The read box's ✕ on an implied-read row revokes both, which
      // is what the host's `remove-read` does for that row.
      const familyBox = (family, titleKey, emptyKey) => {
        const rows = family === 'read'
          ? list.filter((row) => row.readable === true || row.read === true)
          : list.filter((row) => row.write === true)
        const editing = adding === true && (addingFamily ?? 'read') === family
        return h('div', {
          key: `box-${family}`,
          style: { marginTop: 8, padding: '6px 6px 4px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 },
        }, [
          h('div', { key: 'head', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 } }, [
            h('span', { key: 'label' }, props.t(titleKey)),
            h('span', { key: 'count', style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } }, `${rows.length}`),
          ]),
          rows.length === 0
            ? h('div', { key: 'empty', style: { marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, props.t(emptyKey))
            : h('div', { key: 'rows', style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 } }, rows.map((row) => {
              // A directory row ends with a separator, the same form the level
              // descriptions use, so the ellipsis cannot hide what it covers.
              const shown = row.directory === true && !row.path.endsWith('/') ? `${row.path}/` : row.path
              return h('div', {
                key: row.path,
                style: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 6px', borderRadius: 6, background: 'var(--dsw-alias-bg-layer-2)' },
              }, [
                h('span', {
                  key: 'path',
                  title: shown,
                  style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
                }, shown),
                h('button', {
                  key: 'remove',
                  type: 'button',
                  'aria-label': `${props.t('remove')} ${shown}`,
                  // On the read box an implied read cannot be revoked alone, so the
                  // hover text says what the click really does.
                  title: family === 'read' && row.write === true ? props.t('removeImpliedRead') : shown,
                  onClick: () => remove(row.path, family),
                  style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, padding: '0 4px' },
                }, '\u2715'),
              ])
            })),
          // Every box owns its own pair of add actions, so a click can only ever
          // touch the family that box is about.
          editing
            ? h('div', { key: 'manual', style: { marginTop: 6, display: 'flex', gap: 6 } }, [
              h('input', {
                key: 'input',
                type: 'text',
                value: draft,
                placeholder: props.t('allowPlaceholder'),
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') add(draft, family)
                  if (event.key === 'Escape') { setAdding(false); setDraft('') }
                },
                style: {
                  flex: '1 1 auto', minWidth: 0, height: 26, padding: '0 8px', fontSize: 12,
                  border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6,
                  background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
                },
              }),
              h('button', {
                key: 'confirm',
                type: 'button',
                onClick: () => add(draft, family),
                style: { height: 26, padding: '0 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, border: '1px solid var(--dsw-alias-brand-primary)', background: 'transparent', color: 'var(--dsw-alias-brand-primary)' },
              }, props.t('confirm')),
            ])
            : h('div', { key: 'actions', style: { marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' } }, [
              h('button', {
                key: 'pick',
                type: 'button',
                onClick: () => chooseDirectory(family),
                style: { height: 26, padding: '0 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
              }, props.t('pickDirectory')),
              h('button', {
                key: 'manual',
                type: 'button',
                onClick: () => startAdding(family),
                style: { height: 26, padding: '0 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-primary)' },
              }, props.t('enterPath')),
            ]),
        ])
      }

      const panel = open
        ? h('div', { ref: panelRef, role: 'dialog', 'aria-label': props.t('allowTitle'), style: {
          position: 'fixed',
          bottom: anchor.bottom,
          left: anchor.left,
          width: 340,
          maxHeight: '60vh',
          overflowY: 'auto',
          padding: 10,
          ...MENU_SURFACE,
          zIndex: 1100,
          color: 'var(--dsw-alias-label-primary)',
        } }, [
          h('div', { key: 'title', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 } }, [
            h('span', { key: 'label' }, props.t('allowTitle')),
            h('span', { key: 'count', style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400 } }, `${list.length}`),
          ]),
          h('div', { key: 'hint', style: { marginTop: 4, color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: '16px' } }, props.t('allowHint')),
          familyBox('read', 'readBoxTitle', 'readBoxEmpty'),
          familyBox('write', 'writeBoxTitle', 'writeBoxEmpty'),
          error === null ? null : h('div', { key: 'error', role: 'alert', style: { marginTop: 8, color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, whiteSpace: 'normal' } }, error),
        ])
        : null

      // The built-in folder browser, used when the system dialog is unavailable.
      // One level at a time plus the ancestor breadcrumbs; the host's browse
      // backend lists directories only (symlinks that lead to a directory are
      // followed), so every row is enterable.
      const lineStyle = { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: '16px', whiteSpace: 'normal' }
      // The quick places: the two fixed roots plus the drives `loadPlaces` read.
      // They exist so a Windows drive is one click away instead of walking the
      // breadcrumbs up to / and then into /mnt.
      const quickPlaces = () => {
        const items = []
        const listing = browse === null ? null : browse.listing
        const home = listing !== null && listing !== undefined && typeof listing.home === 'string' && listing.home !== '' ? listing.home : null
        if (home !== null) items.push({ key: 'home', label: props.t('browseCrumbHome'), path: home })
        items.push({ key: 'root', label: props.t('browseWslRoot'), path: '/' })
        for (const place of places === null ? [] : places) items.push({ key: 'drive:' + place.path, label: place.label, path: place.path })
        return items
      }
      const browser = browse === null
        ? null
        : h('div', { ref: browserRef, role: 'dialog', 'aria-label': props.t('browseTitle'), style: {
          position: 'fixed',
          bottom: browse.anchor.bottom,
          left: browse.anchor.left,
          width: 360,
          maxHeight: '62vh',
          overflowY: 'auto',
          padding: 10,
          ...MENU_SURFACE,
          zIndex: 1150,
          color: 'var(--dsw-alias-label-primary)',
        } }, [
          h('div', { key: 'title', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 600 } }, [
            h('span', { key: 'label' }, props.t('browseTitle')),
            h('button', {
              key: 'close',
              type: 'button',
              'aria-label': props.t('cancel'),
              onClick: () => setBrowse(null),
              style: { border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', fontSize: 12, padding: '0 4px' },
            }, '\u2715'),
          ]),
          browse.note === null ? null : h('div', { key: 'note', style: { marginTop: 4, ...lineStyle } }, browse.note),
          h('div', { key: 'places', style: { marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', fontSize: 11 } }, [
            h('span', { key: 'label', style: { ...lineStyle } }, props.t('browsePlaces')),
            ...quickPlaces().map((place) => h('button', {
              key: place.key,
              type: 'button',
              title: place.path,
              onClick: () => loadListing(browse.family, place.path),
              style: {
                height: 22, padding: '0 6px', borderRadius: 6, cursor: 'pointer', fontSize: 11,
                border: '1px solid var(--dsw-alias-border-l1)',
                background: 'transparent',
                color: 'var(--dsw-alias-brand-primary)',
                opacity: browse.listing !== null && browse.listing.path === place.path ? 0.5 : 1,
              },
            }, place.label)),
          ]),
          browse.listing === null ? null : h('div', { key: 'crumbs', style: { marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center', fontSize: 11 } }, browse.listing.crumbs.map((crumb, index) => h('button', {
            key: `crumb-${index}`,
            type: 'button',
            title: crumb.path,
            onClick: () => loadListing(browse.family, crumb.path),
            style: {
              border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 2px', fontSize: 11,
              color: 'var(--dsw-alias-brand-primary)',
              textDecoration: index === browse.listing.crumbs.length - 1 ? 'none' : 'underline',
            },
          }, crumb.path === browse.listing.home ? props.t('browseCrumbHome') : crumb.name))),
          browse.listing === null && browse.busy === true
            ? h('div', { key: 'loading', style: { marginTop: 8, ...lineStyle } }, props.t('browseLoading'))
            : null,
          browse.failure === null || browse.failure === undefined
            ? null
            : h('div', { key: 'failure', role: 'alert', style: { marginTop: 8, color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, whiteSpace: 'normal' } }, browse.failure),
          browse.listing === null ? null : h('div', { key: 'entries', style: { marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 } }, [
            ...browse.listing.entries.map((entry) => h('button', {
              key: entry.path,
              type: 'button',
              title: entry.path,
              onClick: () => loadListing(browse.family, entry.path),
              style: {
                display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 8px',
                border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'left', overflow: 'hidden',
                background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
              },
            }, [
              h('span', { key: 'name', style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
              h('span', { key: 'enter', 'aria-hidden': true, style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 } }, '\u203a'),
            ])),
            browse.listing.entries.length === 0
              ? h('div', { key: 'empty', style: { padding: '4px 6px', ...lineStyle } }, props.t('browseEmpty'))
              : null,
            browse.listing.truncated === true
              ? h('div', { key: 'truncated', style: { padding: '4px 6px', ...lineStyle } }, props.t('browseTruncated'))
              : null,
          ]),
          browse.listing === null ? null : h('div', { key: 'actions', style: { marginTop: 8, display: 'flex', gap: 6, justifyContent: 'flex-end' } }, [
            h('button', {
              key: 'up',
              type: 'button',
              disabled: browse.listing.crumbs.length < 2,
              onClick: () => {
                const parent = browse.listing.crumbs[browse.listing.crumbs.length - 2]
                if (parent !== undefined) loadListing(browse.family, parent.path)
              },
              style: {
                height: 26, padding: '0 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
                border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent',
                color: 'var(--dsw-alias-label-primary)', opacity: browse.listing.crumbs.length < 2 ? 0.5 : 1,
              },
            }, props.t('browseUp')),
            h('button', {
              key: 'choose',
              type: 'button',
              onClick: () => {
                const target = browse.listing.path
                setBrowse(null)
                add(target, browse.family)
              },
              style: { height: 26, padding: '0 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, border: '1px solid var(--dsw-alias-brand-primary)', background: 'transparent', color: 'var(--dsw-alias-brand-primary)' },
            }, props.t('browseChoose')),
          ]),
        ])

      return h('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } }, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          title: props.t('allowTitle'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: openPanel,
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: CONTROL_TYPE.gap,
            height: CONTROL_TYPE.height,
            padding: CONTROL_TYPE.padding,
            border: 'none',
            borderRadius: CONTROL_TYPE.radius,
            background: hovered ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            cursor: 'pointer',
            fontSize: CONTROL_TYPE.size,
            fontWeight: CONTROL_TYPE.weight,
            lineHeight: CONTROL_TYPE.lineHeight,
            opacity: restricted ? 1 : 0.6,
          },
        }, [
          // One symbol per control, from the same symbol set as the modes: an
          // emoji cannot be sized and aligned with the neighbouring SVG, and
          // mixing an emoji with inline SVG is what made the two neighbours look
          // unrelated. This one is the solid folder described above.
          h('span', { key: 'icon', 'aria-hidden': true, style: { display: 'inline-flex' } }, ModeSymbol('readable')),
          // Only the symbol keeps the readable-side accent: the label is text,
          // and coloured text here read as if the control itself were a state.
          // `label-secondary` is the tone the shipped composer triggers use.
          h('span', { key: 'label', style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-secondary)' } }, props.t('allowEntry')),
          h('span', { key: 'count', style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, fontWeight: 500 } }, `${list.length}`),
        ]),
        panel === null ? null : portal(panel),
        browser === null ? null : portal(browser),
      ])
    }

    /**
     * Read the live permission catalog through the shipped Remote namespace.
     *
     * The hook contract is the shipped one: a `hooks` source is a bare
     * observable whose state IS the value, so consumers select it directly
     * (`usePermissionCatalog((state) => state)`).
     *
     * Failure handling is deliberate: the first read may not have settled when
     * the first render happens, so a slow read retries on a short interval, a
     * failed read is reported once and retried, and a connection reset starts a
     * fresh read. Nothing here is allowed to leave the seat permanently empty,
     * because this registration replaces the shipped control.
     * @param ctx - client root context.
     * @returns the observable catalog source and its disposer.
     */
    function createCatalog(ctx) {
      const source = createSource(null)
      let alive = true
      let timer = null
      let failureReported = false
      const stopPolling = () => {
        if (timer === null) return
        clearInterval(timer)
        timer = null
      }
      const hasOptions = () => {
        const value = source.getSnapshot()
        return value !== null && Array.isArray(value.options) && value.options.length > 0
      }
      const ensurePolling = () => {
        if (timer !== null || hasOptions()) return
        timer = setInterval(() => {
          if (hasOptions()) {
            stopPolling()
            return
          }
          load()
        }, 3000)
      }
      const load = () => {
        Promise.resolve()
          .then(() => ctx.remote.permissionPresets.catalog())
          .then((result) => {
            if (!alive) return
            if (result !== null && typeof result === 'object' && result.ok === true) {
              source.set(result.value)
              if (hasOptions()) stopPolling()
              else ensurePolling()
              return
            }
            reportFailure(result !== null && typeof result === 'object' ? result.error : undefined)
          })
          .catch((error) => {
            if (!alive) return
            reportFailure(error)
          })
      }
      const reportFailure = (error) => {
        if (!failureReported) {
          failureReported = true
          console.error('[access-permission] permission catalog read failed:', error)
        }
        ensurePolling()
      }
      let stop = () => {}
      try {
        stop = ctx.remote.$on('permission-presets/catalog-changed', load) ?? (() => {})
      } catch (error) {
        console.error('[access-permission] catalog-changed subscription failed:', error)
      }
      try {
        ctx.on('connection/reset', load)
      } catch {
        // A client without that event still gets the polling retry.
      }
      load()
      return {
        source,
        dispose() {
          alive = false
          stopPolling()
          stop()
        },
      }
    }

    /**
     * Render the composer permission control: current mode plus its menu.
     * @param props - session slot props: projection selector, catalog hook, switch action, and copy.
     * @returns The control, or null when no permission capability is composed.
     */
    function PermissionControl(props) {
      const selection = props.useProjection('permissions')
      const catalog = props.usePermissionCatalog((state) => state)
      const [open, setOpen] = React.useState(false)
      const [pick, setPick] = React.useState(null)
      const [confirming, setConfirming] = React.useState(null)
      const [acknowledged, setAcknowledged] = React.useState(false)
      const [anchor, setAnchor] = React.useState({ left: 0, bottom: 0 })
      const [switchError, setSwitchError] = React.useState(null)
      // Hover is the only pointer-driven style here; the shipped control tints
      // its own hover, so this one does too.
      const [hovered, setHovered] = React.useState(false)
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const locked = props.locked === true
      const currentValue = typeof selection?.currentValue === 'string' ? selection.currentValue : undefined

      // A withdrawn option, a lost capability, or a locked composer closes the
      // menu; this mirrors the shipped control's invalidation.
      React.useEffect(() => {
        if (locked || currentValue === undefined) {
          setOpen(false)
          setAcknowledged(false)
          setConfirming(null)
          return
        }
        if (confirming === null) return
        const listed = catalog !== null && Array.isArray(catalog.options) ? catalog.options : []
        if (listed.some((option) => option.value === confirming)) return
        setOpen(false)
        setAcknowledged(false)
        setConfirming(null)
      }, [catalog, confirming, currentValue, locked])

      React.useEffect(() => {
        if (!open) return undefined
        const close = () => {
          setOpen(false)
          setSwitchError(null)
        }
        const inside = (target) => (rootRef.current !== null && rootRef.current.contains(target))
          || (menuRef.current !== null && menuRef.current.contains(target))
        const onPointerDown = (event) => {
          if (!inside(event.target)) close()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        // Losing the anchor's position closes the menu rather than tracking it.
        const onReflow = () => close()
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', onReflow)
        window.addEventListener('scroll', onReflow, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', onReflow)
          window.removeEventListener('scroll', onReflow, true)
        }
      }, [open])

      // This registration replaces the shipped control, so it must never render
      // nothing while the session's permission capability is present. Only a
      // session that genuinely has no permission projection hides the seat; an
      // unsettled catalog read falls back to the built-in table below.
      if (currentValue === undefined) return null
      const served = catalog !== null && Array.isArray(catalog.options) ? catalog.options : []
      const known = new Set(served.map((option) => option.value))
      const options = served.length === 0
        ? FALLBACK_OPTIONS
        : served.concat(FALLBACK_OPTIONS.filter((option) => !known.has(option.value)))
      const current = options.find((option) => option.value === currentValue)
      const shown = pick !== null && options.some((option) => option.value === pick) ? pick : currentValue
      const shownOption = options.find((option) => option.value === shown) ?? current
      const busy = pick !== null || confirming !== null
      // Which table the rows came from: the Host catalog, or the built-in
      // fallback used while that Remote read is unsettled.

      /**
       * Copy for one preset: the two added levels prefer bundle copy, every
       * other preset keeps the Host-supplied name and description. A Host label
       * always wins when it exists, so the menu never contradicts the Host.
       * @param value - preset name.
       * @param field - which copy to resolve.
       * @param fallback - Host-supplied text.
       * @returns the text to show.
       */
      const copyOf = (value, field, fallback) => {
        if (typeof fallback === 'string' && fallback !== '') return fallback
        const mode = MODES[value]
        if (mode === undefined || mode.tone === 'other') return fallback
        const text = props.t(`${mode.tone}.${field}`)
        if (text !== `${mode.tone}.${field}`) return text
        const builtIn = FALLBACK_OPTIONS.find((option) => option.value === value)
        return builtIn === undefined ? fallback : builtIn[field]
      }

      /**
       * Switch preset through the Host. A failure is shown in the menu and the
       * menu stays open: a switch that silently does nothing is indistinguishable
       * from a dead control.
       * @param value - preset name to switch to.
       */
      const submit = (value) => {
        setPick(value)
        setSwitchError(null)
        Promise.resolve(props.selectLevel(value))
          .then((failure) => {
            if (typeof failure === 'string' && failure !== '') {
              console.error('[access-permission] permission switch failed:', failure)
              setSwitchError(failure)
              return
            }
            setOpen(false)
          })
          .catch((error) => {
            console.error('[access-permission] permission switch failed:', error)
            setSwitchError(error instanceof Error ? error.message : String(error))
          })
          .then(() => setPick(null))
      }
      const choose = (value) => {
        if (value === currentValue) {
          setOpen(false)
          return
        }
        if (value === 'danger-full-access') {
          setOpen(false)
          setAcknowledged(false)
          setConfirming(value)
          return
        }
        submit(value)
      }

      const mode = MODES[shown] ?? { symbol: 'readOnly', tone: 'other', accent: 'var(--dsw-alias-label-primary)' }
      const shownLabel = copyOf(shown, 'label', shownOption?.name ?? shown)

      const menuPanel = open
        ? h('div', { key: 'menu', ref: menuRef, role: 'menu', style: {
          position: 'fixed',
          bottom: anchor.bottom,
          left: anchor.left,
          maxHeight: '60vh',
          overflowY: 'auto',
          minWidth: 280,
          maxWidth: 360,
          padding: 4,
          ...MENU_SURFACE,
          zIndex: 1100,
        } }, options.map((option) => {
            const itemMode = MODES[option.value] ?? mode
            const active = option.value === shown
            const label = copyOf(option.value, 'label', option.name)
            // The mode's own one-line note leads, so every row explains itself
            // even when the Host catalog supplies no description.
            const description = itemMode.note === undefined
              ? copyOf(option.value, 'description', option.description)
              : itemMode.note
            return h('button', {
              key: option.value,
              type: 'button',
              role: 'menuitemradio',
              className: 'ap-level-row',
              'aria-checked': active,
              disabled: busy,
              onClick: () => choose(option.value),
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                minHeight: 34,
                textAlign: 'left',
                padding: '6px 8px',
                border: 'none',
                borderRadius: 'var(--dsw-radius-md)',
                cursor: 'pointer',
                // The selected row keeps the host's hover wash instead of an
                // opaque card fill, which would read as a white block on the
                // translucent menu surface.
                background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
                color: 'var(--dsw-alias-label-primary)',
              },
            }, [
              h('span', { key: 'icon', style: { display: 'inline-flex', color: itemMode.accent } }, ModeSymbol(itemMode.symbol)),
              h('span', { key: 'body', style: { display: 'block', minWidth: 0 } }, [
                h('span', { key: 'label', style: {
                  display: 'block',
                  fontSize: 13,
                  fontWeight: 500,
                  lineHeight: '18px',
                  color: itemMode.accent,
                } }, active ? `${label} · ${props.t('current')}` : label),
                description === undefined || description === null
                  ? null
                  : h('span', { key: 'desc', style: { display: 'block', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: '16px', whiteSpace: 'normal' } }, description),
              ]),
            ])
          }).concat(switchError === null ? [] : [h('div', {
            key: 'switch-error',
            role: 'alert',
            style: {
              margin: '4px 4px 2px',
              paddingTop: 6,
              borderTop: '1px solid var(--dsw-alias-state-error-primary)',
              color: 'var(--dsw-alias-state-error-primary)',
              fontSize: 11,
              lineHeight: '16px',
              whiteSpace: 'normal',
            },
          }, [
            h('div', { key: 'msg' }, `${props.t('switchFailed')}${switchError}`),
            h('div', { key: 'hint', style: { marginTop: 4, color: 'var(--dsw-alias-label-secondary)' } }, props.t('restartHint')),
          ])]))
        : null

      const closeConfirmation = () => {
        setAcknowledged(false)
        setConfirming(null)
      }

      // The shipped `RiskConfirmation` over `Modal` (Modal.module.css +
      // RiskConfirmation.module.css): a full-viewport layer that centres a card
      // on `bg-layer-2` with the prominent elevation, the theme's dialog wash
      // painted by the mask over a blurred backdrop, a 22/14/12/24 header, a
      // 24px content column holding the warning row and the acknowledgement, and
      // an outline cancel beside a primary confirm in the footer.
      const confirmationPanel = confirming === null
        ? null
        : h('div', {
          key: 'confirm-layer',
          role: 'presentation',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'max(24px, var(--dsh-frame-overlay-top, 24px)) 24px',
          },
        }, [
          h('div', {
            key: 'mask',
            'aria-hidden': true,
            // The mask dismisses on a press; the card sits above it, so a press
            // inside the dialog never reaches this handler.
            onPointerDown: closeConfirmation,
            style: {
              position: 'absolute',
              inset: 'var(--dsh-frame-chrome-top, 0px) 0 0',
              background: 'var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24))',
              backdropFilter: 'var(--dsw-mask-blur, none)',
            },
          }),
          h('div', {
            key: 'card',
            role: 'dialog',
            'aria-modal': true,
            'aria-label': props.t('confirmTitle'),
            style: {
              boxSizing: 'border-box',
              position: 'relative',
              zIndex: 1,
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
              width: 'min(440px, 100%)',
              maxHeight: '100%',
              padding: '0 0 24px',
              overflow: 'hidden',
              border: 0,
              borderRadius: 'var(--dsw-radius-panel, 16px)',
              background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base))',
              boxShadow: 'var(--dsw-elevation-prominent, 0 3px 8px rgba(0, 0, 0, 0.1))',
              color: 'var(--dsw-alias-label-primary)',
            },
          }, [
            h('div', {
              key: 'content',
              style: { display: 'flex', flexDirection: 'column', width: '100%', minHeight: 0, overflowY: 'auto' },
            }, [
              h('div', {
                key: 'header',
                style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '22px 14px 12px 24px' },
              }, [
                h('h2', {
                  key: 'title',
                  style: { margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
                }, props.t('confirmTitle')),
                h('button', {
                  key: 'close',
                  type: 'button',
                  className: 'ap-dialog-close',
                  'aria-label': props.t('close'),
                  onClick: closeConfirmation,
                  style: {
                    flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 28, height: 28, padding: 0, border: 'none',
                    borderRadius: 'var(--dsw-radius-sm, 8px)', background: 'transparent',
                    cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)',
                  },
                }, ModeSymbol('close')),
              ]),
              h('div', {
                key: 'body',
                style: { display: 'flex', flexDirection: 'column', minWidth: 0, marginTop: 20, padding: '0 24px' },
              }, [
                h('div', {
                  key: 'warning',
                  style: { display: 'flex', alignItems: 'flex-start', gap: 10, color: 'var(--dsw-alias-label-secondary)', fontSize: 14, lineHeight: '22px' },
                }, [
                  h('span', {
                    key: 'icon',
                    'aria-hidden': true,
                    style: { flex: 'none', display: 'inline-flex', marginTop: 2, color: 'var(--dsw-alias-state-error-primary)' },
                  }, ModeSymbol('warning', 18)),
                  h('p', { key: 'text', style: { margin: 0 } }, props.t('confirmDescription')),
                ]),
                h('label', {
                  key: 'ack',
                  style: { display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 20, color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px', cursor: 'pointer' },
                }, [
                  h('input', {
                    key: 'box',
                    type: 'checkbox',
                    checked: acknowledged,
                    onChange: (event) => setAcknowledged(event.target.checked),
                    style: {
                      flex: 'none', width: 16, height: 16, margin: '3px 0 0',
                      accentColor: 'var(--dsw-alias-button-primary-fill)', cursor: 'pointer',
                    },
                  }),
                  h('span', { key: 'text' }, props.t('confirmAcknowledge')),
                ]),
              ]),
            ]),
            h('div', {
              key: 'footer',
              style: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 24px' },
            }, [
              h('button', {
                key: 'cancel',
                type: 'button',
                className: 'ap-dialog-cancel',
                onClick: closeConfirmation,
                style: {
                  boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  height: 36, minWidth: 72, padding: '0 14px',
                  border: '0.5px solid var(--dsw-alias-border-l3)',
                  borderRadius: 'var(--dsw-radius-md, 8px)', background: 'transparent',
                  color: 'var(--dsw-alias-label-primary)', fontSize: 14, lineHeight: '22px', cursor: 'pointer',
                },
              }, props.t('cancel')),
              h('button', {
                key: 'confirm',
                type: 'button',
                className: 'ap-dialog-go',
                disabled: !acknowledged,
                onClick: () => {
                  const value = confirming
                  setAcknowledged(false)
                  setConfirming(null)
                  submit(value)
                },
                style: {
                  boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  height: 36, minWidth: 136, padding: '0 14px', border: 'none',
                  borderRadius: 'var(--dsw-radius-md, 8px)',
                  background: 'var(--dsw-alias-button-primary-fill)',
                  color: 'var(--dsw-alias-label-primary-foreground)',
                  fontSize: 14, lineHeight: '22px',
                  cursor: acknowledged ? 'pointer' : 'not-allowed',
                  opacity: acknowledged ? 1 : 0.4,
                },
              }, props.t('confirmEnable')),
            ]),
          ]),
        ])

      // Both floating surfaces leave the composer's clipping container, so they
      // are portalled; the host's own menus do the same. Without a portal the
      // menu stays in flow, which cannot cover the composer row's siblings.
      const menuLayer = menuPanel === null ? null : portal(menuPanel)
      const confirmationLayer = confirmationPanel === null ? null : portal(confirmationPanel)

      return h('div', { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } }, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: `${shownLabel}｜${mode.note ?? copyOf(shown, 'description', shownOption?.description) ?? props.t('title')}`,
          disabled: locked || busy,
          onClick: () => {
            if (open) {
              setOpen(false)
              return
            }
            if (triggerRef.current !== null && typeof triggerRef.current.getBoundingClientRect === 'function') {
              const rect = triggerRef.current.getBoundingClientRect()
              if (rect.width > 0 || rect.height > 0) {
                const width = typeof window !== 'undefined' && typeof window.innerWidth === 'number' ? window.innerWidth : 1024
                setAnchor({
                  left: Math.max(8, Math.min(rect.left, width - 368)),
                  bottom: Math.max(8, (typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768) - rect.top + 6),
                })
              }
            }
            setOpen(true)
          },
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: CONTROL_TYPE.gap,
            height: CONTROL_TYPE.height,
            padding: CONTROL_TYPE.padding,
            border: 'none',
            borderRadius: CONTROL_TYPE.radius,
            background: hovered && !locked ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
            cursor: locked ? 'default' : 'pointer',
            color: locked ? 'var(--dsw-alias-label-dimmed)' : mode.accent,
            fontSize: CONTROL_TYPE.size,
            fontWeight: CONTROL_TYPE.weight,
            lineHeight: CONTROL_TYPE.lineHeight,
          },
        }, [
          h('span', { key: 'icon', 'aria-label': props.t('glyph'), style: { display: 'inline-flex', color: mode.accent } }, ModeSymbol(mode.symbol)),
          h('span', { key: 'label', style: {
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: mode.accent,
          } }, shownLabel),
          // The chevron is a symbol like every other, so it tints and rotates
          // with the theme instead of being a text glyph in a fixed colour.
          h('span', { key: 'chevron', 'aria-hidden': true, style: { display: 'inline-flex', color: 'var(--dsw-alias-label-caption)', transition: 'transform .12s', transform: open ? 'rotate(180deg)' : 'none' } }, ModeSymbol('chevron')),
        ]),
        // The menu and the dialog are separate stacking contexts: neither may
        // ever overlay the other's controls, and neither covers the page.
        menuLayer,
        confirmationLayer,
      ])
    }

    return {
      // `remote` itself must be injected before any `remote.<namespace>`:
      // reading `ctx.remote` is a service access, so the bare key is what makes
      // the namespace map resolvable at all. Every shipped client plugin that
      // touches a Remote namespace declares it the same way.
      inject: [
        'slots',
        'locale',
        'remote',
        'remote.commands',
        'remote.permissionPresets',
        'remote.directoryPicker',
        'commandUi',
      ],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'access-permission dictionaries')
        // Owns two custom properties, not a rule on host markup: the style element
        // is the only way the palette can follow the theme's light/dark attribute.
        try {
          installLevelPalette()
        } catch (cause) {
          console.error('[access-permission] level palette install failed:', cause)
        }
        const catalog = createCatalog(ctx)
        ctx.effect(() => () => catalog.dispose(), 'access-permission catalog directory')

        /**
         * Run one `/access-allow` line and return its output text.
         * @param sessionId - the session whose list is read or changed.
         * @param line - the command line, including the leading slash.
         * @returns `{ failure }` on a failed call, otherwise `{ text }`.
         */
        const runAllow = async (sessionId, line) => {
          try {
            const result = await ctx.remote.commands.execute(sessionId, line, [])
            if (!result.ok) return { failure: `${result.error.message} (${result.error.code})` }
            if (result.value === undefined) return { failure: 'the host offers no /access-allow command' }
            if (result.value.result?.kind === 'error') return { failure: result.value.result.text }
            return { failure: null, text: result.value.result?.text }
          } catch (cause) {
            return { failure: cause instanceof Error ? cause.message : String(cause) }
          }
        }

        /**
         * Read one session's allowlist.
         * @param sessionId - the session to read.
         * @returns `{ entries }` or `{ failure }`.
         */
        const listAllowed = async (sessionId) => {
          const result = await runAllow(sessionId, '/access-allow list')
          if (result.failure !== null && result.failure !== undefined) return { failure: result.failure, entries: [] }
          const entries = parseAllowMarker(result.text)
          return entries === null ? { failure: 'the host reply carried no allow list', entries: [] } : { entries }
        }

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'access-permission-files',
          order: 10,
          locale: NS,
          inject: (sessionId) => ({
            // The control hands the session back to the add menu's watcher, so a
            // menu click only ever reaches the browser mounted for its session.
            sessionId,
            listAllowed: async () => {
              const listed = await listAllowed(sessionId)
              return { entries: listed.entries, failure: listed.failure }
            },
            addAllowed: async (path, family) => (await runAllow(sessionId, `/access-allow ${family === 'write' ? 'add-write' : 'add'} ${path}`)).failure,
            removeAllowed: async (path, family) => (await runAllow(sessionId, `/access-allow ${family === 'read' ? 'remove-read' : family === 'write' ? 'remove-write' : 'remove'} ${path}`)).failure,
            // The system dialog where one exists. The failure is passed through
            // raw: the control turns it into the note that explains why the
            // built-in browser opened instead.
            pickDirectory: async () => {
              const result = await ctx.remote.directoryPicker.pick()
              if (!result.ok) throw new Error(result.error.message)
              return result.value
            },
            // One directory level for the built-in browser. A failed call is data,
            // not an exception: the browser renders the message in its own row.
            listDirectory: async (path) => {
              try {
                // The generated client counts business arguments: `list` declares
                // one (`path: string | undefined`) and calling it with none throws
                // "expected 1 business argument(s) plus an optional AbortSignal,
                // got 0". Passing `undefined` explicitly is the backend's default
                // (the home directory), so the argument is always present.
                const result = await ctx.remote.directoryPicker.list(
                  typeof path === 'string' && path !== '' ? path : undefined,
                )
                return result.ok ? { listing: result.value } : { failure: result.error.message }
              } catch (cause) {
                return { failure: cause instanceof Error ? cause.message : String(cause) }
              }
            },
          }),
        }, AllowControl))

        // `conversation.input.permission` is a `single` seat, and the shipped
        // control already occupies it at the default priority 0. A second
        // registration at the SAME priority throws (slots core: "single slot
        // ... already has a registration at priority 0 ... register at a
        // different priority to shadow it"), and that throw silently kills this
        // takeover — the shipped control keeps the seat, and it has no icon for
        // our two added presets (its glyph table is hard-coded to the three
        // shipped ones). The lowest priority renders, so claim the seat below
        // the shipped registration.
        ctx.slots.inject('conversation.input.permission', () => ctx.slots.register({
          name: 'conversation.input.permission',
          priority: -1,
          locale: NS,
          inject: (sessionId) => ({
            hooks: { permissionCatalog: catalog.source },
            selectLevel: async (preset) => {
              try {
                const result = await ctx.remote.commands.execute(sessionId, `/permission ${preset}`, [])
                if (!result.ok) return `${result.error.message} (${result.error.code})`
                if (result.value === undefined) return 'the host offers no /permission command'
                if (result.value.result?.kind === 'error') return result.value.result.text
                return null
              } catch (cause) {
                return cause instanceof Error ? cause.message : String(cause)
              }
            },
          }),
        }, PermissionControl))

        // The composer's add menu gains one option under restricted levels.
        try {
          ctx.effect(() => ctx.commandUi.register({
            // The row renders `label`, never this string, so the name is only an
            // identity token — keep it ASCII. A name equal to a host catalog row
            // makes `/` candidate synthesis throw, and that throw blanks the whole
            // add menu, so this must not look like a command.
            name: 'extra-readable-files',
            label: () => ctx.locale.bind(NS)('addAllowed'),
            description: () => ctx.locale.bind(NS)('addAllowedHint'),
            available: (session) => {
              // This runs inside the host's candidate synthesis. A throw here
              // aborts the whole menu — the add button then looks dead — so every
              // failure degrades to "not available" instead of propagating.
              try {
                const value = ctx.sessions.binding(session.sessionId)?.session?.projections?.faceOf('permissions').getSnapshot()
                const preset = typeof value?.currentValue === 'string' ? value.currentValue : undefined
                return preset !== undefined && restrictedPreset(preset)
              } catch {
                return false
              }
            },
            ui: {
              kind: 'action',
              run: (session) => {
                // The system dialog where one exists; otherwise the composer
                // control opens its own browser, because this menu has no React
                // state of its own to render one from.
                Promise.resolve(ctx.remote.directoryPicker.pick())
                  .then((result) => {
                    if (!result.ok) throw new Error(result.error.message)
                    const path = result.value
                    if (typeof path !== 'string' || path === '') return undefined
                    const argument = /\s/.test(path) ? `"${path}"` : path
                    return runAllow(session.sessionId, `/access-allow add ${argument}`)
                  })
                  .catch((cause) => {
                    console.error('[access-permission] system folder dialog unavailable, opening the built-in browser:', cause)
                    requestBrowser(session.sessionId, 'read')
                  })
              },
            },
          }), 'access-permission add-menu entry')
        } catch (cause) {
          console.error('[access-permission] add-menu entry registration failed:', cause)
        }
      },
    }
  },
})
