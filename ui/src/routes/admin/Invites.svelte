<script>
  import { onMount } from 'svelte';
  import { allDocs, putDoc, deleteDoc } from '../../lib/couch.js';

  export let user;

  let invites = [];
  let domains = [];
  let loading = true;
  let error = '';

  let selectedDomain = '';
  let formError = '';
  let copied = '';

  async function loadData() {
    try {
      const [inviteResult, domainResult] = await Promise.all([
        allDocs({ startkey: 'invite-', endkey: 'invite-\ufff0', include_docs: true }),
        allDocs({ include_docs: true })
      ]);
      invites = (inviteResult.rows || []).map(r => r.doc);
      domains = (domainResult.rows || [])
        .filter(r => {
          const id = r.id;
          return id && id.includes('.') &&
            !id.startsWith('org.couchdb.user:') &&
            !id.startsWith('alias-') &&
            !id.startsWith('invite-') &&
            !id.startsWith('_design/');
        })
        .map(r => r.doc);
      if (domains.length > 0 && !selectedDomain) {
        selectedDomain = domains[0]._id;
      }
    } catch (e) {
      error = 'Failed to load data.';
    }
  }

  onMount(async () => {
    await loadData();
    loading = false;
  });

  async function createInvite() {
    formError = '';
    if (!selectedDomain) {
      formError = 'Select a domain.';
      return;
    }
    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
      await putDoc({
        _id: 'invite-' + token,
        domain: selectedDomain,
        created_by: user.name,
        created_at: new Date().toISOString(),
        used_by: null,
        used_at: null
      });
      await loadData();
    } catch (e) {
      formError = e.message || 'Failed to create invite.';
    }
  }

  async function removeInvite(invite) {
    try {
      await deleteDoc(invite);
      await loadData();
    } catch (e) {
      error = e.message || 'Failed to delete invite.';
    }
  }

  function tokenFromId(id) {
    return id.replace('invite-', '');
  }

  function inviteLink(invite) {
    const base = window.location.origin;
    return `${base}/_couchmail/#/register?token=${tokenFromId(invite._id)}`;
  }

  async function copyLink(invite) {
    try {
      await navigator.clipboard.writeText(inviteLink(invite));
      copied = invite._id;
      setTimeout(() => { copied = ''; }, 2000);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = inviteLink(invite);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      copied = invite._id;
      setTimeout(() => { copied = ''; }, 2000);
    }
  }
</script>

<h1>Invites</h1>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else}
  {#if error}
    <p class="error">{error}</p>
  {/if}

  <div class="card">
    <h2>Create invite</h2>
    <form on:submit|preventDefault={createInvite} class="inline-form">
      <select bind:value={selectedDomain}>
        {#each domains as d}
          <option value={d._id}>{d._id}</option>
        {/each}
      </select>
      <button type="submit">Create</button>
    </form>
    {#if formError}
      <p class="error">{formError}</p>
    {/if}
  </div>

  <div class="card">
    <h2>All invites</h2>
    {#if invites.length === 0}
      <p>No invites.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Domain</th>
            <th>Status</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each invites as invite}
            <tr>
              <td class="token">{tokenFromId(invite._id).slice(0, 8)}...</td>
              <td>{invite.domain}</td>
              <td>
                {#if invite.used_by}
                  <span class="used">Used by {invite.used_by}</span>
                {:else}
                  <span class="unused">Available</span>
                {/if}
              </td>
              <td>{new Date(invite.created_at).toLocaleDateString()}</td>
              <td class="actions">
                {#if !invite.used_by}
                  <button class="btn-copy" on:click={() => copyLink(invite)}>
                    {copied === invite._id ? 'Copied!' : 'Copy link'}
                  </button>
                {/if}
                <button class="btn-danger" on:click={() => removeInvite(invite)}>Delete</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
{/if}

<style>
  .inline-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  select {
    font: inherit;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--fg);
    flex: 1;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    text-align: left;
    padding: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  th {
    font-weight: 600;
  }
  .token {
    font-family: monospace;
    font-size: 0.85rem;
  }
  .used {
    color: var(--muted);
  }
  .unused {
    color: #16a34a;
  }
  .actions {
    text-align: right;
    white-space: nowrap;
  }
  .btn-copy {
    background: var(--accent);
    color: #fff;
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
    margin-right: 0.25rem;
  }
  .btn-danger {
    background: #dc2626;
    color: #fff;
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
  }
  .btn-danger:hover {
    background: #b91c1c;
  }
</style>
