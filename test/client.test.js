import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Config as PiAiConfig } from '@deepseek-ai/dsh-llm-pi-ai'

test('client bundle registers a lifecycle-owned Plugins Settings tab', async () => {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    await import('../client.js')
    const plugin = definition.factory((id) => {
      assert.equal(id, 'react')
      return {}
    })
    assert.deepEqual(plugin.inject, [
      'remote',
      'remote.settings',
      'remote.credentials',
      'remote.llm',
      'slots',
      'locale',
      'configForms',
    ])

    const registrations = []
    const injections = []
    const slots = {
      inject(name, callback) {
        injections.push(name)
        return callback()
      },
      register(options, component) {
        registrations.push({ options, component })
        return () => {}
      },
    }
    const locale = {
      register(namespace, dictionaries) {
        assert.equal(namespace, 'settings.cliProxyApi')
        assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh'])
        return () => {}
      },
      bind(namespace) {
        assert.equal(namespace, 'settings.cliProxyApi')
        return (key) => key
      },
    }
    const scope = {
      getSnapshot() {
        return { status: 'loading', value: undefined, revision: undefined, writable: false }
      },
      subscribe() {
        return () => {}
      },
    }
    const configForms = {
      get(namespace) {
        assert.equal(namespace, 'llm-pi-ai')
        return scope
      },
    }
    let effect
    const ctx = {
      get(name) {
        if (name === 'remote') {
          return {
            settings: {},
            credentials: {},
            llm: {},
            $on() { return () => {} },
          }
        }
        if (name === 'slots') return slots
        if (name === 'locale') return locale
        if (name === 'configForms') return configForms
        throw new Error(`unexpected service: ${name}`)
      },
      slots,
      locale,
      configForms,
      effect(factory) {
        effect = factory
        return () => {}
      },
    }
    plugin.apply(ctx)
    assert.equal(typeof effect, 'function')
    assert.deepEqual(injections, ['settings.plugins.tab'])
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].options.name, 'settings.plugins.tab')
    assert.equal(registrations[0].options.id, 'cliproxyapi')
    assert.equal(registrations[0].options.order, 30)
    assert.equal(typeof registrations[0].options.inject, 'function')
    assert.equal(typeof registrations[0].component, 'function')
  } finally {
    delete globalThis.window
  }
})

test('client owns only its Settings slot and keeps the configuration accessible', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /setInterval\s*\(/)
  assert.doesNotMatch(source, /document\./)
  assert.doesNotMatch(source, /MutationObserver/)
  assert.doesNotMatch(source, /querySelector(All)?\s*\(/)
  assert.doesNotMatch(source, /modelsHeading|configuredRows|BOOTSTRAP_ATTRIBUTE|HIDDEN_ATTRIBUTE/)
  assert.match(source, /settings\.plugins\.tab/)
  assert.match(source, /ctx\.configForms/)
  assert.match(source, /slots\.inject\(SETTINGS_SLOT/)
  assert.match(source, /Number\.isInteger\(namespace\.revision\)/)
  assert.match(source, /scope\.subscribe\(/)
  assert.doesNotMatch(source, /remote\.\$on\('settings\/document-updated'/)
  assert.doesNotMatch(source, /remote\.\$on\('credentials\/reference-updated'/)
  assert.match(source, /profile\?\.apiKeyEnv === CREDENTIAL_REF/)
  assert.match(source, /role: 'status'/)
})

test('initial profile waits until the host writes complete model capabilities', async () => {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    await import('../client.js?initial-profile-sync-test')
    const plugin = definition.factory((id) => {
      assert.equal(id, 'react')
      return {}
    })
    const scopeListeners = []
    let currentNamespace = {
      ns: 'llm-pi-ai', revision: 1, value: { providers: {} },
    }
    let scopeSnapshot = {
      status: 'ready', revision: 1, value: {
        providers: {
          CLIProxyAPI: {
            baseURL: 'http://127.0.0.1:8317/v1',
            headers: { authorization: 'Bearer dsh-cliproxyapi-no-key' },
          },
        },
      }, writable: true,
    }
    let bootstrap
    let discoveryRequest
    const ok = (value) => ({ ok: true, value })
    const remote = {
      settings: {
        async describe(...args) {
          assert.deepEqual(args, [])
          return ok({ writable: true, hasDocument: true, namespaces: [currentNamespace] })
        },
        async mutate(namespace, ops, expectedRevision) {
          assert.equal(namespace, 'llm-pi-ai')
          assert.equal(expectedRevision, 1)
          bootstrap = ops[0].value
          currentNamespace = {
            ns: 'llm-pi-ai', revision: 2, value: { providers: { CLIProxyAPI: bootstrap } },
          }
          return ok(currentNamespace)
        },
      },
      credentials: {
        async describe(refs) {
          assert.deepEqual(refs, ['DSH_CLIPROXY_API_KEY'])
          return ok({ DSH_CLIPROXY_API_KEY: { configured: false } })
        },
      },
      llm: {
        async discoverModels(namespace, request) {
          assert.equal(namespace, 'llm-cliproxyapi')
          discoveryRequest = request
          return ok([{
            id: 'gpt-5.6-sol', name: 'GPT 5.6 Sol', contextWindow: 372000, maxTokens: 32768,
          }])
        },
      },
    }
    const scope = {
      getSnapshot() {
        return scopeSnapshot
      },
      subscribe(listener) {
        scopeListeners.push(listener)
        return () => scopeListeners.splice(scopeListeners.indexOf(listener), 1)
      },
    }
    const messages = {
      noModels: 'no models',
      syncTimeout: 'sync timeout',
    }
    let settled = false
    const installing = plugin.installInitialProfile(
      remote, scope, 'http://127.0.0.1:8317/v1', '', messages,
    ).then((profile) => {
      settled = true
      return profile
    })

    for (let attempt = 0; !bootstrap && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    assert.ok(bootstrap)
    assert.equal(discoveryRequest.provider, 'CLIProxyAPI')
    assert.equal(bootstrap.models[0].input, undefined)
    assert.equal(bootstrap.models[0].reasoningEfforts, undefined)
    assert.match(bootstrap.headers['x-dsh-provider-cpa-sync'], /^rich:/)
    const validated = await PiAiConfig['~standard'].validate({
      providers: { CLIProxyAPI: bootstrap },
    })
    assert.equal(validated.issues, undefined)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(settled, false)

    const synchronized = {
      ...bootstrap,
      headers: { authorization: 'Bearer dsh-cliproxyapi-no-key' },
      models: [{
        id: 'gpt-5.6-sol',
        name: 'GPT 5.6 Sol',
        contextWindow: 372000,
        maxTokens: 32768,
        input: ['text', 'image'],
        reasoningEfforts: { low: 'low', high: 'high' },
      }],
    }
    currentNamespace = {
      ns: 'llm-pi-ai', revision: 3, value: { providers: { CLIProxyAPI: synchronized } },
    }
    scopeSnapshot = {
      status: 'ready', revision: 3, value: currentNamespace.value, writable: true,
    }
    for (const listener of [...scopeListeners]) listener()

    const profile = await installing
    assert.deepEqual(profile.models[0].input, ['text', 'image'])
    assert.deepEqual(profile.models[0].reasoningEfforts, { low: 'low', high: 'high' })
    assert.equal(scopeListeners.length, 0)
  } finally {
    delete globalThis.window
  }
})

async function loadSettingsTab(query) {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  try {
    await import('../client.js' + query)
    const state = []
    const React = {
      createElement(tag, props, ...children) {
        return { tag, props, children }
      },
      useEffect() {},
      useMemo(factory) {
        return factory()
      },
      useState(initial) {
        const index = state.length
        state.push(typeof initial === 'function' ? initial() : initial)
        return [state[index], () => {}]
      },
      useSyncExternalStore(subscribe, getSnapshot) {
        subscribe(() => {})
        return getSnapshot()
      },
    }
    const plugin = definition.factory((id) => {
      assert.equal(id, 'react')
      return React
    })
    return plugin.settingsTab
  } finally {
    delete globalThis.window
  }
}

function findSubmitButtons(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.tag === 'button' && node.props?.type === 'submit') out.push(node)
  const children = Array.isArray(node.children) ? node.children : [node.children]
  for (const child of children) {
    if (Array.isArray(child)) for (const entry of child) findSubmitButtons(entry, out)
    else findSubmitButtons(child, out)
  }
  return out
}

test('Save & Enable keys off writability and styles each state unambiguously', async () => {
  const SettingsTab = await loadSettingsTab('?save-button-states-test')
  const render = (snapshot) => findSubmitButtons(SettingsTab({
    remote: {},
    scope: {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
    },
    t: (key) => key,
  }))

  // Mirror still loading: nothing is writable yet, so the form stays disabled.
  const loading = render({ status: 'loading', value: undefined, revision: undefined, writable: false })
  assert.equal(loading.length, 1)
  assert.equal(loading[0].props.disabled, true)
  assert.equal(loading[0].props.style.opacity, 0.55)

  // Ready and writable: enabled with the canonical active-button styling.
  const ready = render({
    status: 'ready',
    revision: 4,
    value: { providers: { CLIProxyAPI: { baseURL: 'http://127.0.0.1:8317/v1' } } },
    writable: true,
  })
  assert.equal(ready.length, 1)
  assert.equal(ready[0].props.disabled, false)
  assert.equal(ready[0].props.style.opacity, undefined)
  assert.match(ready[0].props.style.background, /--dsw-alias-button-primary-fill/)
  assert.match(ready[0].props.style.color, /--dsw-alias-label-primary-foreground/)

  // The namespace view is missing but the document accepts writes: enabled,
  // because the write path describes the namespace itself and shows a precise
  // error instead of a dead form when it is truly absent.
  const unavailable = render({ status: 'unavailable', value: undefined, revision: undefined, writable: true })
  assert.equal(unavailable.length, 1)
  assert.equal(unavailable[0].props.disabled, false)

  // Read-only document: disabled and visibly dimmed.
  const readOnly = render({ status: 'ready', revision: 4, value: { providers: {} }, writable: false })
  assert.equal(readOnly.length, 1)
  assert.equal(readOnly[0].props.disabled, true)
  assert.equal(readOnly[0].props.style.opacity, 0.55)
})
