<script>
  import { onMount } from 'svelte';
  import { parseScript, compileRules } from '../lib/sieve.js';

  export let user;

  let rules = [];
  let rawScript = '';
  let scriptId = null;
  let scriptRev = null;
  let loading = true;
  let saving = false;
  let error = '';
  let success = '';
  let rawMode = false;

  async function loadSieve() {
    try {
      const res = await fetch('/_couchmail/api/sieve', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load sieve script');
      const data = await res.json();
      scriptId = data.scriptId;
      scriptRev = data.scriptRev;
      rawScript = data.script || '';
      const parsed = parseScript(rawScript);
      rules = parsed.rules;
    } catch (e) {
      error = e.message || 'Failed to load sieve script.';
    }
  }

  onMount(async () => {
    await loadSieve();
    loading = false;
  });

  function addRule() {
    rules = [...rules, {
      test: { type: 'header', match: 'contains', field: 'List-Id', value: '' },
      action: { type: 'fileinto', folder: '' }
    }];
  }

  function removeRule(index) {
    rules = rules.filter((_, i) => i !== index);
  }

  function moveRule(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const newRules = [...rules];
    [newRules[index], newRules[target]] = [newRules[target], newRules[index]];
    rules = newRules;
  }

  function updateTestType(index, type) {
    const rule = { ...rules[index] };
    if (type === 'header') {
      rule.test = { type: 'header', match: 'contains', field: 'List-Id', value: rule.test.value || '' };
    } else if (type === 'address') {
      rule.test = { type: 'address', match: 'is', field: 'to', value: rule.test.value || '' };
    } else if (type === 'true') {
      rule.test = { type: 'true' };
    }
    rules[index] = rule;
    rules = rules;
  }

  function updateActionType(index, type) {
    const rule = { ...rules[index] };
    if (type === 'fileinto') {
      rule.action = { type: 'fileinto', folder: rule.action.folder || '' };
    } else if (type === 'redirect') {
      rule.action = { type: 'redirect', address: rule.action.address || '' };
    } else if (type === 'discard') {
      rule.action = { type: 'discard' };
    } else if (type === 'keep') {
      rule.action = { type: 'keep' };
    }
    rules[index] = rule;
    rules = rules;
  }

  function toggleRaw() {
    if (!rawMode) {
      // Entering raw mode — compile current rules
      rawScript = compileRules(rules);
    } else {
      // Leaving raw mode — parse raw back to rules
      const parsed = parseScript(rawScript);
      rules = parsed.rules;
    }
    rawMode = !rawMode;
  }

  async function save() {
    error = '';
    success = '';
    saving = true;
    try {
      const script = rawMode ? rawScript : compileRules(rules);
      const res = await fetch('/_couchmail/api/sieve', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ script, scriptId, scriptRev })
      });
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || 'Failed to save');
      }
      const data = await res.json();
      scriptId = data.scriptId;
      scriptRev = data.scriptRev;
      rawScript = script;
      success = 'Saved.';
      setTimeout(() => { success = ''; }, 3000);
    } catch (e) {
      error = e.message || 'Failed to save sieve script.';
    } finally {
      saving = false;
    }
  }
</script>

<h1>Sieve Filters</h1>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else}
  {#if error}
    <p class="error">{error}</p>
  {/if}
  {#if success}
    <p class="success">{success}</p>
  {/if}

  <div class="card">
    <div class="toolbar">
      <button on:click={toggleRaw} class="btn-toggle">
        {rawMode ? 'Visual editor' : 'Raw script'}
      </button>
      <button on:click={save} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>

    {#if rawMode}
      <textarea bind:value={rawScript} class="raw-editor" rows="20"></textarea>
    {:else}
      <div class="rules">
        {#each rules as rule, i}
          <div class="rule">
            <div class="rule-header">
              <span class="rule-label">
                {#if i === 0}If{:else if rule.test.type === 'true'}Else{:else}Else if{/if}
              </span>
              <div class="rule-actions">
                <button class="btn-sm" on:click={() => moveRule(i, -1)} disabled={i === 0}>&#9650;</button>
                <button class="btn-sm" on:click={() => moveRule(i, 1)} disabled={i === rules.length - 1}>&#9660;</button>
                <button class="btn-sm btn-danger" on:click={() => removeRule(i)}>&#10005;</button>
              </div>
            </div>

            {#if rule.test.type !== 'true'}
              <div class="rule-row">
                <select value={rule.test.type} on:change={(e) => updateTestType(i, e.target.value)}>
                  <option value="header">Header</option>
                  <option value="address">Address</option>
                  <option value="true">Always</option>
                </select>

                {#if rule.test.type === 'header'}
                  <input type="text" bind:value={rule.test.field} placeholder="Header name" class="field-input" />
                  <select bind:value={rule.test.match}>
                    <option value="contains">contains</option>
                    <option value="is">is</option>
                  </select>
                  <input type="text" bind:value={rule.test.value} placeholder="Value" class="value-input" />
                {:else if rule.test.type === 'address'}
                  <select bind:value={rule.test.field}>
                    <option value="to">To</option>
                    <option value="from">From</option>
                  </select>
                  <select bind:value={rule.test.match}>
                    <option value="is">is</option>
                    <option value="contains">contains</option>
                  </select>
                  <input type="text" bind:value={rule.test.value} placeholder="Address" class="value-input" />
                {/if}
              </div>
            {:else}
              <div class="rule-row">
                <select value="true" on:change={(e) => updateTestType(i, e.target.value)}>
                  <option value="header">Header</option>
                  <option value="address">Address</option>
                  <option value="true">Always</option>
                </select>
                <span class="match-all">Matches everything</span>
              </div>
            {/if}

            <div class="rule-row">
              <select value={rule.action.type} on:change={(e) => updateActionType(i, e.target.value)}>
                <option value="fileinto">File into folder</option>
                <option value="redirect">Redirect to</option>
                <option value="discard">Discard</option>
                <option value="keep">Keep (inbox)</option>
              </select>

              {#if rule.action.type === 'fileinto'}
                <input type="text" bind:value={rule.action.folder} placeholder="Folder name" class="value-input" />
              {:else if rule.action.type === 'redirect'}
                <input type="text" bind:value={rule.action.address} placeholder="Redirect address" class="value-input" />
              {/if}
            </div>
          </div>
        {/each}

        <button on:click={addRule} class="btn-add">Add rule</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .toolbar {
    display: flex;
    justify-content: space-between;
    margin-bottom: 1rem;
    gap: 0.5rem;
  }
  .btn-toggle {
    background: var(--muted);
  }
  .raw-editor {
    width: 100%;
    font-family: monospace;
    font-size: 0.9rem;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg);
    color: var(--fg);
    resize: vertical;
  }
  .rules {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .rule {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.75rem;
    background: var(--bg);
  }
  .rule-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  .rule-label {
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--muted);
    text-transform: uppercase;
  }
  .rule-actions {
    display: flex;
    gap: 0.25rem;
  }
  .rule-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.4rem;
    flex-wrap: wrap;
  }
  .rule-row select {
    font: inherit;
    padding: 0.35rem 0.5rem;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
  }
  .field-input {
    width: 120px;
  }
  .value-input {
    flex: 1;
    min-width: 120px;
  }
  .match-all {
    color: var(--muted);
    font-style: italic;
  }
  .btn-sm {
    padding: 0.15rem 0.4rem;
    font-size: 0.8rem;
    line-height: 1;
    min-width: unset;
  }
  .btn-danger {
    background: #dc2626;
    color: #fff;
  }
  .btn-danger:hover {
    background: #b91c1c;
  }
  .btn-add {
    align-self: flex-start;
    margin-top: 0.5rem;
  }
  .success {
    color: #16a34a;
    margin-bottom: 0.5rem;
  }
</style>
