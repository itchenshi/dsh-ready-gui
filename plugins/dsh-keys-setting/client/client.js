// dsh-keys-setting — client (browser) half.
//
// Two jobs:
//
//   1. REMAP the composer's Enter gestures. The engine's keymap is fixed:
//      Enter = send, Shift+Enter = newline, Ctrl/Cmd+Enter = send. This half
//      only intervenes when the user's preference DIFFERS from that default,
//      and it intervenes by re-dispatching the engine's own other gesture — it
//      never touches the editor's content itself. (Verified against the live
//      engine: a synthetic KeyboardEvent drives the composer keymap exactly like
//      a trusted one, including line breaks and submission.)
//
//   2. Provide the settings row in Settings → General (the same seat the
//      engine's own composer-Enter row uses: `settings.general.item`).
//
// COMPOSER IDENTIFICATION: the engine marks its composer editable with the
// semantic attribute `data-composer-input="true"` (verified on a live page:
// `<div contenteditable role="textbox" data-composer-input="true"
// data-lexical-editor="true" …>`). We scope on that attribute alone — never on
// hashed CSS-module classes (which change per build) and never on "any
// contenteditable" (which would also catch a plugin's own editor panes).
//
// INPUT METHODS: a keydown that belongs to an IME composition is never touched
// (`isComposing` / keyCode 229), so Chinese/Japanese input is unaffected.

window.__ModuleLoader__.load({
  id: 'dsh-keys-setting',
  factory: (require) => {
    const React = require('react')
    const jsx = require('react/jsx-runtime')

    /** Host route carrying the preference (registered by the host half). */
    const ROUTE_PATH = '/composer-keys'
    /** Locale namespace for our own strings. */
    const NS = 'composer-keys'
    /** The engine's composer editable. */
    const COMPOSER_SELECTOR = '[data-composer-input="true"]'

    /** Built-in fallbacks: mirror the engine keymap until the host answers. */
    const FALLBACK_DEFAULTS = { enter: 'send', shiftEnter: 'newline', ctrlEnter: 'send' }

    /** The gestures, in the order the settings row lists them. */
    const GESTURES = [
      { key: 'enter', labelKey: 'gestureEnter' },
      { key: 'shiftEnter', labelKey: 'gestureShiftEnter' },
      { key: 'ctrlEnter', labelKey: 'gestureCtrlEnter' },
    ]

    /** What the engine's own keymap does for a gesture (the baseline). */
    const ENGINE_DEFAULT = { enter: 'send', shiftEnter: 'newline', ctrlEnter: 'send' }

    // --- pure decision logic (exported for tests) ---------------------------

    /**
     * Which of our three gestures a KeyboardEvent represents.
     * `null` means "not ours": another key, or an Alt combination (Alt+Enter is
     * the engine's own accelerated gesture and must stay untouched).
     * Shift wins over Ctrl, mirroring the engine keymap where the Shift rule is
     * matched first (`Ctrl+Shift+Enter` therefore folds into Shift+Enter).
     */
    function gestureOf(event) {
      if (event.key !== 'Enter') return null
      if (event.altKey) return null
      if (event.shiftKey) return 'shiftEnter'
      if (event.ctrlKey || event.metaKey) return 'ctrlEnter'
      return 'enter'
    }

    /**
     * True when a keydown belongs to an IME composition and must never be
     * intercepted. `keyCode === 229` covers browsers that never set
     * `isComposing` on the keydown that commits a composition.
     */
    function isComposing(event) {
      return event.isComposing === true || event.keyCode === 229
    }

    /**
     * Decide what to do with one keydown.
     * @returns `null` to leave the event alone, or `{ gesture, dispatch }` where
     *   `dispatch` is the engine gesture to re-emit ('shift' = newline,
     *   'plain' = send).
     */
    function decideGesture(event, prefs) {
      if (event === null || typeof event !== 'object') return null
      if (isComposing(event)) return null
      const gesture = gestureOf(event)
      if (gesture === null) return null
      const wanted = prefs?.[gesture]
      if (wanted !== 'send' && wanted !== 'newline') return null
      // Nothing to do when the preference already matches the engine.
      if (wanted === ENGINE_DEFAULT[gesture]) return null
      return { gesture, dispatch: wanted === 'newline' ? 'shift' : 'plain' }
    }

    /** Build the synthetic event that re-emits one engine gesture. */
    function engineGestureEvent(kind) {
      const shift = kind === 'shift'
      return new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    }

    // --- preference store ---------------------------------------------------

    /** Tiny external store consumed through React.useSyncExternalStore. */
    function createPrefsStore(initial) {
      let state = { value: { ...initial }, defaults: { ...FALLBACK_DEFAULTS }, status: 'loading' }
      const listeners = new Set()
      return {
        get: () => state,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set: (next) => {
          state = { ...state, ...next }
          for (const listener of listeners) listener()
        },
      }
    }

    /** Read the host preference; a failure keeps the fallbacks (no remapping). */
    async function loadPrefs(store) {
      try {
        const res = await fetch(ROUTE_PATH, { headers: { accept: 'application/json' } })
        const body = await res.json().catch(() => null)
        if (body && body.ok === true && body.value) {
          store.set({ value: { ...FALLBACK_DEFAULTS, ...body.value }, defaults: body.defaults ?? FALLBACK_DEFAULTS, status: 'ready' })
          return true
        }
        store.set({ status: 'error' })
        return false
      } catch {
        store.set({ status: 'error' })
        return false
      }
    }

    /** Persist one gesture; optimistic, reverting to the host value on failure. */
    async function savePref(store, key, action) {
      const previous = store.get().value
      store.set({ value: { ...previous, [key]: action } })
      try {
        const res = await fetch(ROUTE_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ [key]: action }),
        })
        const body = await res.json().catch(() => null)
        if (body && body.ok === true && body.value) {
          store.set({ value: { ...FALLBACK_DEFAULTS, ...body.value }, status: 'ready' })
          return true
        }
      } catch {
        /* fall through to the revert */
      }
      store.set({ value: previous, status: 'error' })
      return false
    }

    // --- key remapping ------------------------------------------------------

    /**
     * Install the capture-phase listener. Capture phase is required: the engine
     * binds its keymap on the editor itself, so a bubble-phase listener would
     * run after the engine already acted.
     * @returns the disposer.
     */
    function installKeyRemap(store) {
      // Our own synthetic event re-enters this listener; skip it once.
      let reentrant = false
      const onKeyDown = (event) => {
        if (reentrant) return
        const target = event.target
        if (!target || typeof target.closest !== 'function') return
        if (target.closest(COMPOSER_SELECTOR) === null) return
        const decision = decideGesture(event, store.get().value)
        if (decision === null) return
        // Stop the engine from acting on the original gesture, then emit the
        // gesture the user actually asked for — the engine still owns the
        // semantics (what "send" and "newline" mean).
        event.preventDefault()
        event.stopPropagation()
        reentrant = true
        try {
          target.dispatchEvent(engineGestureEvent(decision.dispatch))
        } finally {
          reentrant = false
        }
      }
      document.addEventListener('keydown', onKeyDown, true)
      return () => document.removeEventListener('keydown', onKeyDown, true)
    }

    // --- locale -------------------------------------------------------------

    const zhDict = {
      __lang: 'zh-CN',
      title: '按键设置',
      desc: '设置 Enter / Shift+Enter / Ctrl+Enter 是发送消息还是换行（macOS 上 Ctrl 为 ⌘）',
      gestureEnter: 'Enter',
      gestureShiftEnter: 'Shift + Enter',
      gestureCtrlEnter: 'Ctrl + Enter',
      actionSend: '发送消息',
      actionNewline: '换行',
      saveFailed: '保存失败，已还原',
    }
    const enDict = {
      __lang: 'en-US',
      title: 'Key bindings',
      desc: 'Choose whether Enter / Shift+Enter / Ctrl+Enter sends the message or inserts a line break (⌘ on macOS)',
      gestureEnter: 'Enter',
      gestureShiftEnter: 'Shift + Enter',
      gestureCtrlEnter: 'Ctrl + Enter',
      actionSend: 'Send message',
      actionNewline: 'Line break',
      saveFailed: 'Could not save — reverted',
    }

    // --- settings row -------------------------------------------------------

    // Styling is COPIED VERBATIM from the engine's General-page rows — the row
    // shell, typography and pill selector from the composer-Enter row
    // (`.T1PP_q_row/.rowText/.title/.desc/.selector`) and the popup menu from the
    // engine's Menu component (`._list_/._portal_/._item_/._itemLabel_/._check_`
    // in the web shell's stylesheet, plus its measured panel shadow). A native
    // `<select>` was tried first and rejected: the browser draws its own arrow
    // and inner padding, so it can never match the pill. Every declaration uses
    // the engine's theme variables (`--dsw-alias-*`), so the row follows the
    // light/dark palette automatically.
    //
    // Importing the engine's primitives package was deliberately avoided:
    // declaring engine client packages in `dsh.client.inject` re-registers whole
    // bundles (a known footgun), and the module loader rejects externals
    // requested before its boot.
    const STYLE_ID = 'dsh-keys-setting-style'
    const ROW_CSS = [
      '.dsh-ck-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:flex-start;gap:8px;padding:16px 0;display:flex}',
      '.dsh-ck-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}',
      '.dsh-ck-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.dsh-ck-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
      '.dsh-ck-error{color:var(--dsw-alias-label-error,#e5534b);font-size:12px;line-height:18px}',
      '.dsh-ck-controls{flex-direction:column;flex:none;gap:8px;display:flex}',
      '.dsh-ck-line{align-items:center;gap:12px;justify-content:flex-end;display:flex}',
      '.dsh-ck-key{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;white-space:nowrap}',
      '.dsh-ck-wrap{position:relative;align-items:center;display:inline-flex}',
      // the engine's `.selector`: a 36px pill that fits its content
      '.dsh-ck-pill{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
      '.dsh-ck-pill:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ck-pill:disabled{opacity:.6;cursor:default}',
      '.dsh-ck-chevron{flex:none}',
      // the engine's Menu popup (portaled, 4px inset, 20px radius)
      '.dsh-ck-menu{position:fixed;z-index:1100;min-width:218px;max-width:360px;background:var(--dsw-alias-bg-base);border-radius:20px;padding:4px;box-shadow:0 0 0 .5px rgba(0,0,0,.04),0 3px 8px 0 rgba(0,0,0,.04),0 0 20px 0 rgba(0,0,0,.05);display:flex;flex-direction:column;max-height:calc(100vh - 24px);overflow-y:auto}',
      '.dsh-ck-item{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);text-align:left}',
      '.dsh-ck-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-ck-itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-ck-check{flex:none;color:var(--dsw-alias-label-primary)}',
    ].join('')

    /** Inject the row stylesheet once; returns the disposer. */
    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = ROW_CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    /** The engine's 14px chevron, drawn with the same visual weight. */
    function ChevronGlyph() {
      return jsx.jsx('svg', {
        className: 'dsh-ck-chevron',
        width: 14,
        height: 14,
        viewBox: '0 0 14 14',
        fill: 'none',
        'aria-hidden': 'true',
        children: jsx.jsx('path', {
          d: 'M3.5 5.25 7 8.75 10.5 5.25',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      })
    }

    /** The menu's selected-item check (the engine marks selection with a glyph). */
    function CheckGlyph() {
      return jsx.jsx('svg', {
        className: 'dsh-ck-check',
        width: 14,
        height: 14,
        viewBox: '0 0 14 14',
        fill: 'none',
        'aria-hidden': 'true',
        children: jsx.jsx('path', {
          d: 'M2.75 7.5 5.5 10.25 11.25 4',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      })
    }

    /**
     * One gesture's control: the engine's pill button + its portaled menu.
     * Replaces a native `<select>` so the control matches the neighbouring rows
     * exactly (a native select draws its own arrow and inner padding).
     */
    function GesturePicker({ gestureKey, labelText, value, disabled, onPick, t }) {
      const [open, setOpen] = React.useState(false)
      const [anchor, setAnchor] = React.useState(null)
      const wrapRef = React.useRef(null)
      const menuRef = React.useRef(null)

      const close = () => {
        setOpen(false)
        setAnchor(null)
      }

      const toggle = () => {
        if (open) return close()
        const button = wrapRef.current && wrapRef.current.querySelector('button')
        if (!button) return
        const rect = button.getBoundingClientRect()
        // Flip above the button when there is not enough room below (the engine's
        // menu does the same); `bottom` anchoring keeps it inside the viewport.
        const below = window.innerHeight - rect.bottom
        const above = rect.top
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - 218 - 8))
        setAnchor(below < 120 && above > below
          ? { left, bottom: Math.max(8, window.innerHeight - rect.top + 4) }
          : { left, top: rect.bottom + 4 })
        setOpen(true)
      }

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (wrapRef.current && wrapRef.current.contains(target)) return
          if (menuRef.current && menuRef.current.contains(target)) return
          close()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      const pick = (action) => {
        close()
        void onPick(action)
      }

      return jsx.jsxs('span', {
        className: 'dsh-ck-wrap',
        ref: wrapRef,
        children: [
          jsx.jsxs('button', {
            type: 'button',
            className: 'dsh-ck-pill',
            'aria-label': `${t('title')} ${labelText}`,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            disabled,
            onClick: toggle,
            children: [
              value === 'send' ? t('actionSend') : t('actionNewline'),
              jsx.jsx(ChevronGlyph, {}),
            ],
          }),
          open && anchor
            ? jsx.jsx('div', {
                className: 'dsh-ck-menu',
                role: 'menu',
                ref: menuRef,
                style: anchor,
                children: ['send', 'newline'].map((action) =>
                  jsx.jsxs(
                    'button',
                    {
                      key: action,
                      type: 'button',
                      role: 'menuitem',
                      className: 'dsh-ck-item',
                      onClick: () => pick(action),
                      children: [
                        jsx.jsx('span', {
                          className: 'dsh-ck-itemLabel',
                          children: action === 'send' ? t('actionSend') : t('actionNewline'),
                        }),
                        value === action ? jsx.jsx(CheckGlyph, {}) : null,
                      ],
                    },
                    action,
                  ),
                ),
              })
            : null,
        ],
      })
    }

    function ComposerKeysRow(props) {
      const { usePrefs, setPref, t } = props
      const state = usePrefs()
      const [failed, setFailed] = React.useState(false)

      const onPick = (key) => async (action) => {
        const ok = await setPref(key, action)
        setFailed(!ok)
      }

      return jsx.jsxs('div', {
        className: 'dsh-ck-row',
        children: [
          jsx.jsxs('div', {
            className: 'dsh-ck-rowText',
            children: [
              jsx.jsx('div', { className: 'dsh-ck-title', children: t('title') }),
              jsx.jsx('div', { className: 'dsh-ck-desc', children: t('desc') }),
              failed ? jsx.jsx('div', { className: 'dsh-ck-error', children: t('saveFailed') }) : null,
            ],
          }),
          jsx.jsx('div', {
            className: 'dsh-ck-controls',
            children: GESTURES.map((gesture) =>
              jsx.jsxs(
                'div',
                {
                  key: gesture.key,
                  className: 'dsh-ck-line',
                  children: [
                    jsx.jsx('span', { className: 'dsh-ck-key', children: t(gesture.labelKey) }),
                    jsx.jsx(GesturePicker, {
                      gestureKey: gesture.key,
                      labelText: t(gesture.labelKey),
                      value: state.value[gesture.key],
                      disabled: state.status === 'error',
                      onPick: onPick(gesture.key),
                      t,
                    }),
                  ],
                },
                gesture.key,
              ),
            ),
          }),
        ],
      })
    }

    // --- plugin face --------------------------------------------------------

    const name = 'composer-keys'
    const inject = ['slots', 'locale']

    function apply(ctx) {
      const store = createPrefsStore(FALLBACK_DEFAULTS)
      // Load first, then remap: until the host answers, the fallbacks equal the
      // engine's defaults, so nothing is intercepted either way.
      void loadPrefs(store).then(() => {
        ctx.effect(() => {
          const disposeKeymap = installKeyRemap(store)
          // settings.yaml is editable by hand (and the documented config path),
          // so re-read when the window regains focus — the file edit then takes
          // effect on the next click into the page, with no reload.
          const onFocus = () => {
            void loadPrefs(store)
          }
          window.addEventListener('focus', onFocus)
          return () => {
            disposeKeymap()
            window.removeEventListener('focus', onFocus)
          }
        }, 'composer-keys:keymap')
      })

      ctx.effect(() => ctx.locale.register(NS, { zh: zhDict, en: enDict }), 'composer-keys:dict')

      // The row's stylesheet, injected once for the page's lifetime.
      ctx.effect(() => installStyles(), 'composer-keys:styles')

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'composer-keys',
            // The engine's own composer row uses order 20; sit right below it.
            order: 21,
            locale: NS,
            inject: () => ({
              usePrefs: () => React.useSyncExternalStore(store.subscribe, store.get, store.get),
              setPref: (key, action) => savePref(store, key, action),
            }),
          },
          ComposerKeysRow,
        ),
      )
    }

    return {
      name,
      inject,
      apply,
      // Exported for unit tests.
      gestureOf,
      isComposing,
      decideGesture,
      engineGestureEvent,
      createPrefsStore,
      installStyles,
      FALLBACK_DEFAULTS,
      ENGINE_DEFAULT,
      GESTURES,
      COMPOSER_SELECTOR,
      STYLE_ID,
      ROW_CSS,
    }
  },
})
