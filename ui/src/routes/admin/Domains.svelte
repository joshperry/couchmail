<script>
  import { onMount } from 'svelte';
  import { allDocs, putDoc, deleteDoc } from '../../lib/couch.js';

  export let user;

  let domains = [];
  let newDomain = '';
  let loading = true;
  let error = '';
  let formError = '';

  async function loadDomains() {
    try {
      const result = await allDocs({ include_docs: true });
      domains = (result.rows || [])
        .filter(r => {
          const id = r.id;
          return id &&
            id.includes('.') &&
            !id.startsWith('org.couchdb.user:') &&
            !id.startsWith('alias-') &&
            !id.startsWith('_design/');
        })
        .map(r => r.doc);
    } catch (e) {
      error = 'Failed to load domains.';
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
      await putDoc({ _id: name });
      newDomain = '';
      await loadDomains();
    } catch (e) {
      formError = e.message || 'Failed to add domain.';
    }
  }

  async function removeDomain(domain) {
    try {
      await deleteDoc(domain);
      await loadDomains();
    } catch (e) {
      error = e.message || 'Failed to delete domain.';
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

  <div class="card">
    <h2>Domains</h2>
    {#if domains.length === 0}
      <p>No domains configured.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Domain</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each domains as domain}
            <tr>
              <td>{domain._id}</td>
              <td class="actions">
                <button class="btn-danger" on:click={() => removeDomain(domain)}>Delete</button>
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
</style>
