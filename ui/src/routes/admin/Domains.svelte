<script>
  import { onMount } from 'svelte';
  import { api, enc, isAdmin } from '../../lib/api.js';

  export let user;

  let domains = [];
  let newDomain = '';
  let newAdmin = {};
  let loading = true;
  let error = '';
  let formError = '';

  $: globalAdmin = isAdmin(user);

  async function loadDomains() {
    try {
      domains = (await api('GET', '/admin/domains')).domains;
    } catch (e) {
      error = e.message || 'Failed to load domains.';
    }
  }

  onMount(async () => {
    await loadDomains();
    loading = false;
  });

  async function addDomain() {
    formError = '';
    const name = newDomain.trim();
    if (!name) {
      formError = 'Domain name is required.';
      return;
    }
    try {
      await api('POST', '/admin/domains', { name });
      newDomain = '';
      await loadDomains();
    } catch (e) {
      formError = e.message || 'Failed to add domain.';
    }
  }

  async function removeDomain(domain) {
    if (!confirm(`Stop accepting mail for ${domain.name}?`)) return;
    error = '';
    try {
      await api('DELETE', `/admin/domains/${enc(domain.name)}`);
      await loadDomains();
    } catch (e) {
      error = e.message || 'Failed to delete domain.';
    }
  }

  async function addAdmin(domain) {
    error = '';
    const address = (newAdmin[domain.name] || '').trim();
    if (!address) return;
    try {
      await api('PUT', `/admin/domains/${enc(domain.name)}/admins/${enc(address)}`);
      newAdmin[domain.name] = '';
      await loadDomains();
    } catch (e) {
      error = e.message || 'Failed to add domain admin.';
    }
  }

  async function removeAdmin(domain, address) {
    error = '';
    try {
      await api('DELETE', `/admin/domains/${enc(domain.name)}/admins/${enc(address)}`);
      await loadDomains();
    } catch (e) {
      error = e.message || 'Failed to remove domain admin.';
    }
  }
</script>

<h1>Domains</h1>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else}
  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if globalAdmin}
    <div class="card">
      <h2>Add domain</h2>
      <form on:submit|preventDefault={addDomain} class="inline-form">
        <input type="text" bind:value={newDomain} placeholder="example.com" />
        <button type="submit">Add</button>
      </form>
      {#if formError}
        <p class="error">{formError}</p>
      {/if}
    </div>
  {/if}

  <div class="card">
    <h2>{globalAdmin ? 'Domains' : 'Your domains'}</h2>
    {#if domains.length === 0}
      <p>No domains configured.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Domain</th>
            <th>Users</th>
            <th>Aliases</th>
            <th>Domain admins</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each domains as domain}
            <tr>
              <td>{domain.name}</td>
              <td>{domain.users}</td>
              <td>{domain.aliases}</td>
              <td>
                {#each domain.admins as admin}
                  <div class="admin">
                    {admin}
                    {#if globalAdmin}
                      <button class="btn-link" title="Remove" on:click={() => removeAdmin(domain, admin)}>&times;</button>
                    {/if}
                  </div>
                {:else}
                  <span class="muted">none</span>
                {/each}
                {#if globalAdmin}
                  <form class="inline-form small" on:submit|preventDefault={() => addAdmin(domain)}>
                    <input type="text" bind:value={newAdmin[domain.name]} placeholder="user@{domain.name}" />
                    <button type="submit">Add</button>
                  </form>
                {/if}
              </td>
              <td class="actions">
                {#if globalAdmin}
                  <button class="btn-danger" disabled={domain.users + domain.aliases > 0}
                    title={domain.users + domain.aliases > 0 ? 'Remove its users and aliases first' : ''}
                    on:click={() => removeDomain(domain)}>Delete</button>
                {/if}
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
  .inline-form input {
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
  .actions {
    text-align: right;
    white-space: nowrap;
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
  .btn-danger:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .admin {
    white-space: nowrap;
  }
  .btn-link {
    background: none;
    border: none;
    color: #dc2626;
    padding: 0 0.25rem;
    cursor: pointer;
  }
  .muted {
    opacity: 0.6;
  }
  .inline-form.small {
    margin-top: 0.25rem;
  }
  .inline-form.small input,
  .inline-form.small button {
    font-size: 0.85rem;
    padding: 0.25rem 0.5rem;
  }
</style>
