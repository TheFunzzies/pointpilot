(() => {
  const bridge = window.pointpilot || null;
  const $ = id => document.getElementById(id);
  const provider = $('aiProvider');
  const model = $('aiModel');
  const answer = $('aiAnswer');
  const message = $('aiMessage');
  let connected = { openai: false, anthropic: false };

  function setModels(items) {
    const current = model.value;
    model.replaceChildren();
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      model.append(option);
    }
    if (items.some(item => item.value === current)) model.value = current;
    if (!items.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Connect a provider first';
      model.append(option);
    }
  }

  function updateProviderModels() {
    if (provider.value === 'openai') {
      const status = $('aiOpenAiStatus').dataset.models;
      let models = [];
      try { models = JSON.parse(status || '[]'); } catch { /* Use empty list. */ }
      setModels(models.map(item => ({ value: item.slug, label: item.displayName || item.slug })));
    } else {
      setModels([
        { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
        { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
        { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }
      ]);
    }
  }

  async function refreshStatus() {
    if (!bridge) {
      $('aiOpenAiStatus').textContent = 'AI sign-in is available in the installed desktop app.';
      $('aiOpenAiConnect').disabled = true;
      $('aiClaudeStatus').textContent = 'AI requests are available in the installed desktop app.';
      $('aiClaudeSave').disabled = true;
      $('aiAsk').disabled = true;
      return;
    }
    try {
      const status = await bridge.llmStatus();
      const openai = status.openai || {};
      connected.openai = openai.status === 'connected' && openai.sharing;
      $('aiOpenAiStatus').textContent = connected.openai
        ? `Connected${openai.identity?.email ? ` as ${openai.identity.email}` : ''} · ChatGPT plan usage enabled`
        : openai.status === 'connected' ? 'Signed in; approve ChatGPT plan usage to use the assistant.' : 'Not connected';
      $('aiOpenAiStatus').dataset.models = JSON.stringify(openai.models || []);
      $('aiOpenAiConnect').textContent = openai.status === 'connected' ? 'Reconnect / review access' : 'Sign in with ChatGPT';
      $('aiOpenAiDisconnect').hidden = openai.status !== 'connected';
      connected.anthropic = Boolean(status.anthropic?.connected);
      $('aiClaudeStatus').textContent = connected.anthropic ? 'API key encrypted and saved on this PC' : 'API key not connected';
      $('aiClaudeRemove').hidden = !connected.anthropic;
      updateProviderModels();
    } catch (error) {
      message.textContent = error.message || 'Could not load provider status.';
    }
  }

  $('aiOpenAiConnect').addEventListener('click', async () => {
    $('aiOpenAiConnect').disabled = true;
    message.textContent = 'Complete sign-in in your browser…';
    try {
      await bridge.llmOpenAiSignIn();
      await refreshStatus();
      message.textContent = 'ChatGPT connection updated.';
    } catch (error) { message.textContent = error.message || 'ChatGPT sign-in failed.'; }
    finally { $('aiOpenAiConnect').disabled = false; }
  });

  $('aiOpenAiDisconnect').addEventListener('click', async () => {
    try { await bridge.llmOpenAiDisconnect(); await refreshStatus(); message.textContent = 'ChatGPT disconnected.'; }
    catch (error) { message.textContent = error.message || 'Could not disconnect ChatGPT.'; }
  });

  $('aiClaudeSave').addEventListener('click', async () => {
    const key = $('aiClaudeKey').value;
    if (!key.trim()) { message.textContent = 'Paste an Anthropic Console API key first.'; return; }
    $('aiClaudeSave').disabled = true;
    try {
      await bridge.llmSaveClaudeKey(key);
      $('aiClaudeKey').value = '';
      await refreshStatus();
      message.textContent = 'Claude API key encrypted and saved on this PC.';
    } catch (error) { message.textContent = error.message || 'Could not save the Claude API key.'; }
    finally { $('aiClaudeSave').disabled = false; }
  });

  $('aiClaudeRemove').addEventListener('click', async () => {
    try { await bridge.llmRemoveClaudeKey(); await refreshStatus(); message.textContent = 'Claude API key removed.'; }
    catch (error) { message.textContent = error.message || 'Could not remove the Claude API key.'; }
  });

  provider.addEventListener('change', updateProviderModels);

  $('aiIncludeWallet').addEventListener('change', async event => {
    const preview = $('aiContextPreview');
    if (!event.target.checked) { preview.hidden = true; preview.textContent = ''; return; }
    preview.hidden = false;
    preview.textContent = 'Loading the saved balances that will be included…';
    try {
      const response = await fetch('/api/user');
      if (!response.ok) throw new Error('Could not read the saved wallet.');
      const wallet = await response.json();
      const rows = (wallet.balances || []).filter(item => Number(item.balance) > 0).map(item => `${item.program || item.code}: ${Number(item.balance).toLocaleString()}`);
      preview.textContent = rows.length ? `Balances shared with this question:\n${rows.join('\n')}\nPoint currencies remain separate.` : 'Your saved wallet has no point balances to share.';
    } catch (error) { preview.textContent = error.message || 'Could not load the wallet preview.'; }
  });

  $('aiAsk').addEventListener('click', async () => {
    const prompt = $('aiPrompt').value.trim();
    if (!prompt) { message.textContent = 'Write a question first.'; return; }
    if (!bridge) { message.textContent = 'Use the installed desktop app to connect a provider.'; return; }
    if (!connected[provider.value]) { message.textContent = `Connect ${provider.value === 'openai' ? 'ChatGPT' : 'Claude'} first.`; return; }
    answer.hidden = true;
    $('aiAsk').disabled = true;
    message.textContent = 'Thinking…';
    try {
      const result = await bridge.llmAsk({ provider: provider.value, model: model.value, prompt, includeWallet: $('aiIncludeWallet').checked });
      answer.textContent = result.text || 'The model returned an empty answer.';
      answer.hidden = false;
      message.textContent = `Answered with ${result.model}. This response may be wrong; verify travel details in PointPilot.`;
    } catch (error) { message.textContent = error.message || 'The assistant request failed.'; }
    finally { $('aiAsk').disabled = false; }
  });

  refreshStatus();
})();
