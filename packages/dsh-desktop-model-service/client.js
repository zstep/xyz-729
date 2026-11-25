window.__ModuleLoader__.load({
  id: 'dsh-desktop-model-service',
  factory: require => {
    const React = require('react')
    const h = React.createElement
    const NS = 'settings.desktopModelService'
    const zh = {
      title: '鹏宝模型底座', legacyTitle: '模型连接', imageModels: '图片模型', noImageModels: '暂无可用图片模型。', description: '集中管理鹏宝模型并连接兼容插件。新安装或启用插件后，需重启工作区服务以更新能力列表。', refresh: '刷新', loading: '正在读取…', unavailable: '暂时无法读取模型服务。',
      chat: '文本聊天', image: '图片生成', video: '视频', unverified: '未审核', availableState: '可用', unavailableState: '不可用', noDefault: '暂无默认模型信息',
      imageModelsUnavailable: '图片模型目录暂不可用；将保留服务器默认选择，不可手动指定模型。',
      chatModels: '文本模型', videoModels: '视频模型', videoCount: '可用模型', noVideoModels: '暂无可用视频模型。请检查鹏宝 AI 中的视频来源、模型配置和权限。', videoCatalogUnavailable: '视频模型目录暂时无法读取，请刷新重试。', videoSource: '模型来源', volcengine: '火山引擎', alibaba: '阿里云', openai: 'OpenAI / 兼容来源', viewAllModels: '查看全部模型', hideModels: '收起模型列表', noChatModels: '暂无可用文本模型。',
      consumers: '能力连接', connect: '连接', connected: '已连接', already: '已由内置适配器连接', needsAdapter: '需要适配器', conflict: '配置冲突', readOnly: '只读', notConnected: '未连接',
      connectAll: '连接所有兼容插件', ready: '可连接', skipped: '已跳过',
      chatDefault: '文本默认模型', imageDefault: '图片默认模型', videoDefault: '视频默认模型', noModel: '暂未选择', model: '模型', provider: '服务商', select: '选择模型',
      checkConfiguration: '检查配置', apply: '应用', applying: '应用中…', cancel: '取消', rollback: '撤销上次变更', applied: '已应用', rolledBack: '已撤销', noChanges: '当前无需修改。',
      change: '变更', from: '原值', to: '新值', expires: '配置检查即将过期', videoHint: '视频能力尚未审核，当前仅展示状态。',
      assistantTitle: '插件配置助手', assistantDescription: '分析已启用插件的配置结构，检查变更后明确确认保存。凭据仅由宿主填入。', assistantSelect: '选择插件', assistantAnalyze: '分析配置', assistantAnalyzing: '正在分析配置…', assistantCancel: '取消分析或检查', assistantRefresh: '刷新插件列表', assistantEmpty: '暂无可分析的插件。', assistantUnsupported: '暂不支持此插件', assistantPreview: '检查待保存配置', assistantConfirm: '我已检查变更并同意保存', assistantSave: '确认保存并验证', assistantSaving: '正在保存并验证…', assistantSaved: '已保存且运行时验证通过。', assistantVerificationFailed: '运行时验证未通过；请检查插件状态，或在可用时撤销本次变更。', assistantExpired: '配置分析已过期，请重新分析。', assistantRollback: '撤销助手变更', assistantRollingBack: '正在撤销…', assistantRolledBack: '助手变更已撤销。', assistantFailed: '插件配置操作失败，请重试。', assistantEvidenceUnavailable: '缺少足够的插件源码证据，无法安全分析配置；请更新插件或手动配置。', assistantInvalidProposal: '无法为该插件的配置结构生成安全的字段映射；请确认插件版本或手动配置。', assistantModelUnavailable: '服务器默认模型暂不可用，无法安全填写模型。', assistantPluginUnavailable: '插件当前未启用或不可配置，请刷新插件列表后重试。', assistantConflict: '插件配置在分析后发生变化，请重新分析。', assistantAnalysisFailed: '分析未完成，请重试。', assistantAnalysisTimeout: '分析超时，请重试。', assistantAnalysisLimit: '插件配置结构或模型输出超出限制。', assistantNotApproved: '宿主未批准这次配置变更（插件配置、版本或证据已变化）；请刷新插件列表并重新分析。', assistantRecoveryRequired: '保存未完成，且自动恢复未完成；请检查插件配置，必要时重启工作区服务后重试。', assistantUnavailable: '插件配置运行时不可用，请重启工作区服务后重试。', assistantInventoryFailed: '无法读取插件列表，请刷新重试。', assistantCapabilities: '配置能力', assistantExpires: '失效时间',
      modelUnavailable: '所选模型不可用。', failed: '操作失败，请刷新后重试。'
    }
    const en = {
      title: 'Pengbao model foundation', legacyTitle: 'Model connections', imageModels: 'Image models', noImageModels: 'No image models are currently available.', description: 'Manage Pengbao models and connect compatible plugins. Restart the workspace service after installing or enabling plugins to update capabilities.', refresh: 'Refresh', loading: 'Loading…', unavailable: 'The model service is temporarily unavailable.',
      chat: 'Chat', image: 'Image generation', video: 'Video', unverified: 'Unverified', availableState: 'Available', unavailableState: 'Unavailable', noDefault: 'Default model information is unavailable',
      imageModelsUnavailable: 'The image model catalog is unavailable; the server default is retained and cannot be overridden.',
      chatModels: 'Chat models', videoModels: 'Video models', videoCount: 'Available models', noVideoModels: 'No video models are available. Check video sources, model configuration and permissions in Pengbao AI.', videoCatalogUnavailable: 'The video model catalog is temporarily unavailable. Refresh to retry.', videoSource: 'Model source', volcengine: 'Volcengine', alibaba: 'Alibaba Cloud', openai: 'OpenAI / compatible', viewAllModels: 'View all models', hideModels: 'Hide model list', noChatModels: 'No chat models are currently available.',
      consumers: 'Capability connections', connect: 'Connect', connected: 'Connected', already: 'Connected by built-in adapter', needsAdapter: 'Adapter required', conflict: 'Configuration conflict', readOnly: 'Read-only', notConnected: 'Not connected', connectAll: 'Connect all compatible plugins', ready: 'Ready to connect', skipped: 'Skipped',
      chatDefault: 'Chat default model', imageDefault: 'Image default model', videoDefault: 'Video default model', noModel: 'No model selected', model: 'Model', provider: 'Provider', select: 'Select a model',
      checkConfiguration: 'Check configuration', apply: 'Apply', applying: 'Applying…', cancel: 'Cancel', rollback: 'Undo last change', applied: 'Applied', rolledBack: 'Rolled back', noChanges: 'No changes are needed.',
      change: 'Change', from: 'Previous', to: 'New', expires: 'Configuration check expires shortly', videoHint: 'Video capability is not verified; status is informational only.',
      assistantTitle: 'Plugin configuration assistant', assistantDescription: 'Analyze enabled plugins and inspect changes before explicitly confirming a save. Only the host supplies credentials.', assistantSelect: 'Select a plugin', assistantAnalyze: 'Analyze configuration', assistantAnalyzing: 'Analyzing configuration…', assistantCancel: 'Cancel analysis or review', assistantRefresh: 'Refresh plugin list', assistantEmpty: 'No plugins are available for analysis.', assistantUnsupported: 'This plugin is not supported', assistantPreview: 'Review configuration changes', assistantConfirm: 'I reviewed the changes and agree to save', assistantSave: 'Confirm save and verify', assistantSaving: 'Saving and verifying…', assistantSaved: 'Saved and verified in the runtime.', assistantVerificationFailed: 'Runtime verification failed. Check the plugin status or undo this change when available.', assistantExpired: 'This analysis expired. Analyze the plugin again.', assistantRollback: 'Undo assistant change', assistantRollingBack: 'Undoing change…', assistantRolledBack: 'The assistant change was undone.', assistantFailed: 'The plugin configuration operation failed. Try again.', assistantEvidenceUnavailable: 'Not enough plugin source evidence is available to analyze the configuration safely. Update the plugin or configure it manually.', assistantInvalidProposal: 'No safe field mapping could be produced for this plugin schema. Check the plugin version or configure it manually.', assistantModelUnavailable: 'The server default model is unavailable, so the model cannot be filled safely.', assistantPluginUnavailable: 'The plugin is not enabled or not configurable. Refresh the plugin list and try again.', assistantConflict: 'The plugin configuration changed after analysis. Analyze it again.', assistantAnalysisFailed: 'The analysis did not complete. Try again.', assistantAnalysisTimeout: 'The analysis timed out. Try again.', assistantAnalysisLimit: 'The plugin schema or the model output exceeded the limit.', assistantNotApproved: 'The host did not approve this configuration change (the plugin configuration, version, or evidence changed). Refresh the plugin list and analyze again.', assistantRecoveryRequired: 'The save did not complete and automatic recovery failed. Check the plugin configuration, restart the workspace service if needed, and try again.', assistantUnavailable: 'The plugin configuration runtime is unavailable. Restart the workspace service and try again.', assistantInventoryFailed: 'The plugin list could not be loaded. Refresh and try again.', assistantCapabilities: 'Capabilities', assistantExpires: 'Expires',
      modelUnavailable: 'The selected model is unavailable.', failed: 'The operation failed. Refresh and try again.'
    }
    const css = `
      .dshModelService{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px}
      .dshModelServiceHeader{display:flex;align-items:flex-start;gap:12px}.dshModelServiceHeaderText{flex:1;min-width:0}.dshModelServiceTitle{margin:0;font-size:20px;font-weight:600;line-height:30px}.dshModelServiceDesc{margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
      .dshModelServiceButton{appearance:none;border:1px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;min-height:34px;padding:0 13px;font:inherit;font-size:13px;cursor:pointer}.dshModelServiceButton:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}.dshModelServiceButton:disabled{opacity:.45;cursor:default}.dshModelServicePrimary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}.dshModelServicePrimary:hover:not(:disabled){opacity:.86}
      .dshModelServiceSection{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:14px;display:flex;flex-direction:column;gap:10px}.dshModelServiceSectionTitle{font-size:14px;font-weight:600}.dshModelServiceGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.dshModelServiceCard{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:13px;display:flex;flex-direction:column;gap:8px;min-width:0}.dshModelServiceCardTitle{font-size:13px;font-weight:600}.dshModelServiceCardMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dshModelServiceCardState{font-size:12px;color:var(--dsw-alias-label-secondary)}.dshModelServiceCardState[data-state=conflict],.dshModelServiceError{color:var(--dsw-alias-state-error-primary)}
      .dshModelServiceDiagnostic{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      .dshModelServiceField{display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}.dshModelServiceField select{height:34px;min-width:0;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:0 8px;font:inherit}.dshModelServiceActions{display:flex;justify-content:flex-end;align-items:center;gap:8px;flex-wrap:wrap}.dshModelServiceNotice{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.dshModelServiceModelBlock{display:flex;flex-direction:column;gap:6px}.dshModelServiceToggle{align-self:flex-start;appearance:none;border:0;background:transparent;padding:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;text-decoration:underline;text-underline-offset:2px}.dshModelServiceToggle:hover{color:var(--dsw-alias-label-primary)}.dshModelServiceModelList{margin:0;padding:0 0 0 16px;max-height:168px;overflow-y:auto;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.dshModelServiceModelList li{overflow-wrap:anywhere}.dshModelServicePreview{border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}.dshModelServicePreviewRow{display:grid;grid-template-columns:minmax(90px,.7fr) minmax(0,1fr) minmax(0,1fr);gap:8px;font-size:12px;line-height:18px}.dshModelServicePreviewRow span{overflow-wrap:anywhere}.dshModelServicePreviewLabel{color:var(--dsw-alias-label-secondary)}
      .dshModelServiceAssistant{gap:12px}.dshModelServiceAssistant h3{margin:0}.dshModelServiceAssistant .dshModelServicePreviewRow{grid-template-columns:minmax(100px,.7fr) minmax(0,1.3fr)}.dshModelServiceAssistant .dshModelServicePreviewRow span:last-child{white-space:pre-wrap;font-family:monospace}.dshModelServiceAssistant input{accent-color:var(--dsw-alias-label-primary)}.dshModelServiceAssistant button:focus-visible,.dshModelServiceAssistant select:focus-visible,.dshModelServiceAssistant input:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:3px}
      @media(max-width:560px){.dshModelServiceGrid{grid-template-columns:1fr}.dshModelServicePreviewRow,.dshModelServiceAssistant .dshModelServicePreviewRow{grid-template-columns:1fr}.dshModelServicePreviewRow span:first-child{font-weight:600}}
    `
    const hcap = capability => capability === 'chat.completions' ? 'chat' : capability === 'image.generate' ? 'image' : capability === 'video.generate' ? 'video' : capability
    const failure = error => ({ key: { INVALID_PROPOSAL: 'assistantInvalidProposal', MODEL_UNAVAILABLE: 'assistantModelUnavailable',
      PLUGIN_UNAVAILABLE: 'assistantPluginUnavailable', CONFLICT: 'assistantConflict', EVIDENCE_CHANGED: 'assistantConflict', ANALYSIS_FAILED: 'assistantAnalysisFailed',
      ANALYSIS_TIMEOUT: 'assistantAnalysisTimeout', ANALYSIS_LIMIT: 'assistantAnalysisLimit', UNAVAILABLE: 'assistantUnavailable',
      ANALYSIS_UNAVAILABLE: 'assistantUnavailable', EVIDENCE_UNAVAILABLE: 'assistantEvidenceUnavailable', 'unavailable': 'assistantUnavailable', PLAN_EXPIRED: 'assistantExpired',
      FORBIDDEN: 'assistantNotApproved', VERIFICATION_FAILED: 'assistantVerificationFailed', RECOVERY_REQUIRED: 'assistantRecoveryRequired'
    }[error?.code] || 'assistantFailed', detail: typeof error?.detail === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(error.detail) ? error.detail : '' })
    const stateText = (state, t) => ({ connected: t('connected'), 'already-connected': t('already'), 'needs-adapter': t('needsAdapter'), conflict: t('conflict'), 'read-only': t('readOnly'), 'not-connected': t('notConnected'), ready: t('ready'), skipped: t('skipped') }[state] || state)
    function useConfigurationAssistant({ t, callApi }) {
      const [plugins, setPlugins] = React.useState(null)
      const [selected, setSelected] = React.useState('')
      const [busy, setBusy] = React.useState('inventory')
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [plan, setPlan] = React.useState(null)
      const [confirmed, setConfirmed] = React.useState(false)
      const [receipt, setReceipt] = React.useState('')
      const operation = React.useRef({ generation: 0, controller: null, alive: true, cancellable: false, busy: false })
      const begin = kind => {
        operation.current.controller?.abort()
        const controller = new AbortController()
        const generation = ++operation.current.generation
        operation.current.controller = controller
        operation.current.busy = true
        setBusy(kind); setError(''); setStatus('')
        return { signal: controller.signal, valid: () => operation.current.alive && generation === operation.current.generation && !controller.signal.aborted }
      }
      const finish = request => { if (request.valid()) { operation.current.busy = false; setBusy('') } }
      const load = async () => {
        const request = begin('inventory')
        try {
          const result = await callApi('configuration.inventory', undefined, request.signal)
          if (!request.valid()) return
          if (!Array.isArray(result.plugins)) throw new Error('inventory')
          setPlugins(result.plugins)
          setSelected(current => result.plugins.some(plugin => plugin.entryId === current) ? current : result.plugins.find(plugin => plugin.supported)?.entryId || '')
        } catch { if (request.valid()) setError('assistantInventoryFailed') }
        finally { finish(request) }
      }
      React.useEffect(() => {
        operation.current.alive = true
        void load()
        return () => {
          operation.current.alive = false
          operation.current.generation++
          operation.current.controller?.abort()
          if (operation.current.cancellable) void callApi('configuration.cancel', {}).catch(() => {})
        }
      }, [callApi])
      const cancel = async () => {
        const request = begin('cancel')
        setPlan(null); setConfirmed(false)
        try {
          await callApi('configuration.cancel', {}, request.signal)
          if (request.valid()) operation.current.cancellable = false
        } catch (error) { if (request.valid()) setError(failure(error)) }
        finally { finish(request) }
      }
      const analyze = async () => {
        if (operation.current.busy || !plugins?.some(plugin => plugin.entryId === selected && plugin.supported)) return
        const request = begin('analyze')
        operation.current.cancellable = true
        setPlan(null); setConfirmed(false)
        try {
          const result = await callApi('configuration.analyze', { entryId: selected }, request.signal)
          if (!request.valid()) return
          if (result.entryId !== selected || typeof result.planId !== 'string' || !Array.isArray(result.writes) || !Number.isFinite(result.expiresAt)) throw new Error('plan')
          setPlan(result)
        } catch (error) { if (request.valid()) setError(failure(error)) }
        finally { finish(request) }
      }
      const save = async () => {
        if (operation.current.busy || !plan || !confirmed) return
        if (plan.expiresAt <= Date.now()) { setPlan(null); setConfirmed(false); setError('assistantExpired'); return }
        const planId = plan.planId
        const request = begin('save')
        operation.current.cancellable = false
        setPlan(null); setConfirmed(false); setReceipt('')
        try {
          const result = await callApi('configuration.apply', { planId }, request.signal)
          if (!request.valid()) return
          setReceipt(typeof result.receiptId === 'string' ? result.receiptId : '')
          if (result.status === 'saved-active') setStatus('assistantSaved')
          else setError(result.status === 'verification-failed' ? 'assistantVerificationFailed' : 'assistantFailed')
        } catch (error) { if (request.valid()) setError(failure(error)) }
        finally { finish(request) }
      }
      const rollback = async () => {
        if (operation.current.busy || !receipt) return
        const request = begin('rollback')
        try {
          const result = await callApi('configuration.rollback', { receiptId: receipt }, request.signal)
          if (!request.valid()) return
          if (result.status === 'rolled-back') { setReceipt(''); setStatus('assistantRolledBack') }
          else setError(result.status === 'verification-failed' ? 'assistantVerificationFailed' : 'assistantFailed')
        } catch (error) { if (request.valid()) setError(failure(error)) }
        finally { finish(request) }
      }
      return h('section', { className: 'dshModelServiceCard dshModelServiceAssistant', 'data-testid': 'plugin-configuration-assistant', 'aria-busy': !!busy },
        h('h3', { className: 'dshModelServiceSectionTitle' }, t('assistantTitle')),
        h('p', { className: 'dshModelServiceNotice' }, t('assistantDescription')),
        error && h('p', { className: 'dshModelServiceError', role: 'alert' }, typeof error === 'string' ? t(error)
          : h('span', null, t(error.key), error.detail ? h('span', { className: 'dshModelServiceDiagnostic' }, ` · ${error.detail}`) : null)),
        h('div', { role: 'status', 'aria-live': 'polite', className: 'dshModelServiceNotice' }, busy ? t(busy === 'analyze' ? 'assistantAnalyzing' : busy === 'save' ? 'assistantSaving' : busy === 'rollback' ? 'assistantRollingBack' : 'loading') : status ? t(status) : ''),
        plugins?.length ? h('label', { className: 'dshModelServiceField' }, t('assistantSelect'), h('select', { value: selected, disabled: !!busy || !!plan, onChange: event => { setSelected(event.target.value); setError(''); setStatus(''); setConfirmed(false) } },
          h('option', { value: '', disabled: true }, t('assistantSelect')),
          plugins.map(plugin => h('option', { key: plugin.entryId, value: plugin.entryId, disabled: !plugin.supported }, `${plugin.packageName || plugin.entryId} · ${plugin.packageVersion || ''} (${plugin.entryId})${plugin.supported ? '' : ` — ${t('assistantUnsupported')}`}`))))
          : plugins && !busy && h('p', { className: 'dshModelServiceNotice' }, t('assistantEmpty')),
        plan && h('section', { className: 'dshModelServicePreview', 'aria-label': t('assistantPreview'), 'data-testid': 'plugin-configuration-preview' },
          h('strong', null, t('assistantPreview')),
          h('p', { className: 'dshModelServiceNotice' }, `${plan.packageName} · ${plan.packageVersion}`),
          h('p', { className: 'dshModelServiceNotice' }, `${t('assistantCapabilities')}: ${(plan.capabilities || []).map(capability => t(hcap(capability))).join(', ')}`),
          plan.writes.map((write, index) => h('div', { className: 'dshModelServicePreviewRow', key: index }, h('span', { className: 'dshModelServicePreviewLabel' }, write.path.join('.')), h('span', null, JSON.stringify(write.value)))),
          h('p', { className: 'dshModelServiceNotice' }, `${t('assistantExpires')}: ${new Date(plan.expiresAt).toLocaleString()}`),
          h('label', { className: 'dshModelServiceNotice' }, h('input', { type: 'checkbox', checked: confirmed, disabled: !!busy, onChange: event => setConfirmed(event.target.checked) }), ` ${t('assistantConfirm')}`),
          h('button', { className: 'dshModelServiceButton dshModelServicePrimary', type: 'button', disabled: !!busy || !confirmed, onClick: () => void save() }, t('assistantSave'))),
        h('div', { className: 'dshModelServiceActions' },
          h('button', { className: 'dshModelServiceButton', type: 'button', disabled: !!busy || !!plan, onClick: () => void load() }, t('assistantRefresh')),
          !plan && h('button', { className: 'dshModelServiceButton', type: 'button', disabled: !!busy || !plugins?.some(plugin => plugin.entryId === selected && plugin.supported), onClick: () => void analyze() }, t('assistantAnalyze')),
          (busy === 'analyze' || plan) && h('button', { className: 'dshModelServiceButton', type: 'button', disabled: busy === 'cancel', onClick: () => void cancel() }, t('assistantCancel')),
          receipt && h('button', { className: 'dshModelServiceButton', type: 'button', disabled: !!busy || !!plan, onClick: () => void rollback() }, t('assistantRollback'))))
    }
    function ModelServiceSettings({ t, callApi }) {
      const assistant = useConfigurationAssistant({ t, callApi })
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [preview, setPreview] = React.useState(null)
      const [receiptId, setReceiptId] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [skips, setSkips] = React.useState(new Set())
      const [openModels, setOpenModels] = React.useState({})
      const planRequest = React.useRef(0)
      const load = React.useCallback(async signal => {
        const request = ++planRequest.current
        setPreview(null); setBusy(true); setError('')
        try {
          const next = await callApi('overview', undefined, signal)
          if (signal?.aborted || request !== planRequest.current) return
          setData(next)
          setReceiptId(next.rollbackAvailable ? next.receiptId || '' : '')
        } catch { if (!signal?.aborted && request === planRequest.current) setError('unavailable') }
        finally { if (!signal?.aborted && request === planRequest.current) setBusy(false) }
      }, [callApi])
      React.useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => { controller.abort(); planRequest.current++ } }, [load])
      const invalidatePreview = () => { planRequest.current++; setPreview(null) }
      const makePlan = async input => {
        const request = ++planRequest.current
        setBusy(true); setError(''); setStatus(''); setPreview(null)
        try {
          const plan = await callApi('plan', input)
          if (request !== planRequest.current) return
          setPreview(plan)
          if (input.action === 'connect-all') setSkips(new Set((input.skipConsumerIds ?? [])))
          setStatus('')
        } catch (failure) {
          if (request === planRequest.current) setError(failure?.code === 'MODEL_UNAVAILABLE' ? 'modelUnavailable' : 'failed')
        } finally {
          if (request === planRequest.current) setBusy(false)
        }
      }
      const connectAll = () => makePlan({ action: 'connect-all', skipConsumerIds: [...skips] })
      const apply = async () => {
        if (busy || !preview?.id) return
        if (preview.expiresAt <= Date.now()) { invalidatePreview(); setError('failed'); return }
        const planId = preview.id
        invalidatePreview(); setBusy(true); setError('')
        try { const result = await callApi('apply', { planId }); setReceiptId(result.receiptId || ''); setStatus(result.state === 'applied' ? 'applied' : 'noChanges'); await load() }
        catch (failure) { setError(failure?.code === 'CONFLICT' ? 'conflict' : 'failed') }
        finally { setBusy(false) }
      }
      const rollback = async () => {
        if (busy || !receiptId) return
        invalidatePreview(); setBusy(true); setError('')
        try { await callApi('rollback', { receiptId }); setReceiptId(''); setStatus('rolledBack'); await load() } catch { setError('conflict') } finally { setBusy(false) }
      }
      if (!data) return h('section', { className: 'dshModelService' }, h('div', { className: 'dshModelServiceHeader' }, h('div', { className: 'dshModelServiceHeaderText' }, h('h2', { className: 'dshModelServiceTitle' }, t('title')), h('p', { className: 'dshModelServiceDesc' }, error ? t(error) : t('loading')))), assistant)
      const defaultName = (selection, id) => {
        const model = data.models?.find(model => model.id === id)
        return selection?.alias || selection?.name || model?.alias || model?.name || id || t('noDefault')
      }
      const modelsFor = scope => (data.models || []).filter(model => model.capabilities?.includes(scope))
      const modelBlock = (kind, scope, emptyKey) => h('div', { className: 'dshModelServiceModelBlock' },
        h('button', { className: 'dshModelServiceToggle', type: 'button', 'aria-expanded': !!openModels[kind], 'data-testid': `model-service-${kind}-models-toggle`,
          onClick: () => setOpenModels(current => ({ ...current, [kind]: !current[kind] })) }, openModels[kind] ? t('hideModels') : t('viewAllModels')),
        openModels[kind] && (modelsFor(scope).length
          ? h('ul', { className: 'dshModelServiceModelList', 'data-testid': `model-service-${kind}-models` }, modelsFor(scope).map(model => h('li', { key: model.id }, model.alias || model.name || model.id)))
          : h('p', { className: 'dshModelServiceNotice', 'data-testid': `model-service-${kind}-models-empty` }, t(emptyKey))))
      const videoModels = data.video?.models || []
      const videoBlock = h('div', { className: 'dshModelServiceModelBlock' },
        h('button', { className: 'dshModelServiceToggle', type: 'button', 'aria-expanded': !!openModels.video, 'data-testid': 'model-service-video-models-toggle',
          onClick: () => setOpenModels(current => ({ ...current, video: !current.video })) }, openModels.video ? t('hideModels') : t('viewAllModels')),
        openModels.video && (videoModels.length
          ? h('ul', { className: 'dshModelServiceModelList', 'data-testid': 'model-service-video-models' }, videoModels.map(model => h('li', { key: model.id },
            model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id,
            h('span', { className: 'dshModelServiceCardMeta' }, ` — ${t('videoSource')}: ${['volcengine', 'alibaba', 'openai'].includes(model.provider) ? t(model.provider) : t('provider')}`))))
          : h('p', { className: 'dshModelServiceNotice', 'data-testid': 'model-service-video-models-empty' }, t(data.video?.reason === 'unavailable' ? 'videoCatalogUnavailable' : 'noVideoModels'))))
      return h('section', { className: 'dshModelService', 'data-testid': 'desktop-model-service-settings' },
        h('div', { className: 'dshModelServiceHeader' }, h('div', { className: 'dshModelServiceHeaderText' }, h('h2', { className: 'dshModelServiceTitle' }, t('title')), h('p', { className: 'dshModelServiceDesc' }, t('description'))), h('button', { className: 'dshModelServiceButton', type: 'button', disabled: busy, onClick: () => void load() }, t('refresh'))),
        error && h('p', { className: 'dshModelServiceError', role: 'alert' }, t(error)),
        h('div', { className: 'dshModelServiceGrid' },
          h('div', { className: 'dshModelServiceCard', 'data-testid': 'model-service-chat-card' }, h('span', { className: 'dshModelServiceCardTitle' }, t('chat')), h('span', { className: 'dshModelServiceCardState' }, data.availability?.chat?.available ? `${t('provider')}: pengbao` : t('unavailableState')), h('p', { className: 'dshModelServiceNotice', 'data-testid': 'model-service-chat-default' }, `${t('chatDefault')}: ${defaultName(data.defaults?.chat, data.defaults?.chat?.model)}`), h('span', { className: 'dshModelServiceCardMeta' }, t('chatModels')), modelBlock('chat', 'chat.completions', 'noChatModels')),
          h('div', { className: 'dshModelServiceCard', 'data-testid': 'model-service-image-card' }, h('span', { className: 'dshModelServiceCardTitle' }, t('image')), h('span', { className: 'dshModelServiceCardState' }, data.availability?.image?.available ? t('availableState') : t('unavailableState')), h('p', { className: 'dshModelServiceNotice', 'data-testid': 'model-service-image-default' }, `${t('imageDefault')}: ${defaultName(data.defaults?.image, data.defaults?.image?.id)}`), h('span', { className: 'dshModelServiceCardMeta' }, t('imageModels')), modelBlock('image', 'image.generate', 'noImageModels'), data.imageCatalogStatus === 'models-unavailable' && h('p', { className: 'dshModelServiceNotice' }, t('imageModelsUnavailable'))),
          h('div', { className: 'dshModelServiceCard', 'data-testid': 'model-service-video-card' },
            h('span', { className: 'dshModelServiceCardTitle' }, t('video')),
            h('span', { className: 'dshModelServiceCardState' }, data.video?.available ? t('availableState') : t('unavailableState')),
            h('p', { className: 'dshModelServiceNotice' }, `${t('videoCount')}: ${videoModels.length}`),
            h('p', { className: 'dshModelServiceNotice', 'data-testid': 'model-service-video-default' },
              `${t('videoDefault')}: ${videoModels.find(model => model.id === data.video?.defaultModel)?.name || data.video?.defaultModel || t('noDefault')}`),
            h('span', { className: 'dshModelServiceCardMeta' }, t('videoModels')), videoBlock)),
        assistant,
        h('div', { className: 'dshModelServiceSection' }, h('span', { className: 'dshModelServiceSectionTitle' }, t('consumers')), data.consumers?.some(consumer => consumer.adapter === 'facade' && consumer.state === 'not-connected') && h('button', { className: 'dshModelServiceButton dshModelServicePrimary', type: 'button', disabled: busy || !data.writable, onClick: connectAll }, t('connectAll')), h('div', { className: 'dshModelServiceGrid' }, (data.consumers || []).map(consumer => h('div', { className: 'dshModelServiceCard', key: consumer.id }, h('span', { className: 'dshModelServiceCardTitle' }, consumer.id), h('span', { className: 'dshModelServiceCardMeta' }, consumer.version || t('needsAdapter')), h('span', { className: 'dshModelServiceCardState', 'data-state': consumer.state }, stateText(consumer.state, t)), consumer.state === 'not-connected' && h('button', { className: 'dshModelServiceButton', type: 'button', disabled: busy || !data.writable, onClick: () => void makePlan({ action: 'connect', consumerId: consumer.id }) }, t('connect')))))),
        preview && h('div', { className: 'dshModelServicePreview', role: 'dialog', 'aria-label': t('checkConfiguration') }, h('strong', null, t('checkConfiguration')), preview.candidates?.map(candidate => { const checked = candidate.state !== 'skipped' && !skips.has(candidate.id); const disabled = busy || candidate.state === 'conflict' || candidate.state === 'already-connected'; const onChange = event => { const next = new Set(skips); event.target.checked ? next.delete(candidate.id) : next.add(candidate.id); setSkips(next); void makePlan({ action: 'connect-all', skipConsumerIds: [...next] }) }; return h('label', { key: candidate.id, className: 'dshModelServiceNotice' }, h('input', { type: 'checkbox', checked, disabled, onChange }), ` ${candidate.id}: ${t(candidate.state === 'conflict' ? 'conflict' : candidate.state === 'skipped' ? 'skipped' : candidate.state === 'ready' ? 'ready' : 'connected')}`) }), preview.changes?.length ? preview.changes.map((change, index) => h('div', { className: 'dshModelServicePreviewRow', key: index }, h('span', { className: 'dshModelServicePreviewLabel' }, change.path.join('.')), h('span', null, `${t('from')}: ${change.before && typeof change.before === 'object' ? JSON.stringify(change.before) : String(change.before ?? t('noModel'))}`), h('span', null, `${t('to')}: ${change.after && typeof change.after === 'object' ? JSON.stringify(change.after) : String(change.after ?? t('noModel'))}`))) : h('p', { className: 'dshModelServiceNotice' }, t('noChanges')), h('p', { className: 'dshModelServiceNotice' }, t('expires')), h('div', { className: 'dshModelServiceActions' }, h('button', { className: 'dshModelServiceButton', type: 'button', disabled: busy, onClick: invalidatePreview }, t('cancel')), h('button', { className: 'dshModelServiceButton dshModelServicePrimary', type: 'button', disabled: busy, onClick: () => void apply() }, busy ? t('applying') : t('apply')))),
        h('div', { className: 'dshModelServiceActions' }, status && h('span', { className: 'dshModelServiceNotice', role: 'status' }, t(status)), receiptId && h('button', { className: 'dshModelServiceButton', type: 'button', disabled: busy, onClick: () => void rollback() }, t('rollback'))))
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const callApi = async (endpoint, payload, signal) => {
          const options = { method: endpoint === 'overview' || endpoint === 'configuration.inventory' ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal }
          if (payload !== undefined) { options.headers = { 'Content-Type': 'application/json' }; options.body = JSON.stringify(payload) }
          const response = await fetch(`/api/model-service.${endpoint}`, options)
          const text = await response.text(); let data
          try { data = text ? JSON.parse(text) : {} } catch { throw { code: 'unavailable' } }
          if (!response.ok) throw data
          return data
        }
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'model service locale')
        ctx.effect(() => { if (document.querySelector('style[data-plugin-css="dsh-desktop-model-service"]')) return; const style = document.createElement('style'); style.dataset.pluginCss = 'dsh-desktop-model-service'; style.textContent = css; document.head.appendChild(style); return () => style.remove() }, 'model service styles')
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({ name: 'settings.plugins.tab', id: 'desktop-model-service', order: -90, locale: NS, label: () => t('title'), inject: () => ({ t, callApi }) }, ModelServiceSettings))
      }
    }
  }
})
