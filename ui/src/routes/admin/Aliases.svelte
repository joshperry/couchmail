<script>
  import { onMount } from 'svelte';
  import { allDocs, putDoc, deleteDoc, getDoc } from '../../lib/couch.js';

  export let user;

  let aliases = [];
  let loading = true;
  let error = '';

  let newAddress = '';
  let newTarget = '';
  let newDescription = '';
  let formError = '';

  let editingId = null;
  let editTarget = '';
  let editDescription = '';

  async function loadAliases() {
    try {
      const result = await allDocs({
        startkey: 'alias-',
        endkey: 'alias-\ufff0',
        include_docs: true
      });
      aliases = (result.rows || []).map(r => r.doc);
    } catch (e) {
      error = 'Failed to load aliases.';
    }
  }

  onMount(async () => {
    await loadAliases();
    loading = false;
  });

  async function createAlias() {
    formError = '';
    const address = newAddress.trim();
    const target = newTarget.trim();
    if (!address) {
      formError = 'Address is required.';
      return;
    }
    if (!target) {
      formError = 'Target email is required.';
      return;
    }
    try {
      await putDoc({
        _id: 'alias-' + address,
        target,
        description: newDescription.trim()
      });
      newAddress = '';
      newTarget = '';
      newDescription = '';
      await loadAliases();
    } catch (e) {
      formError = e.message || 'Failed to create alias.';
    }
  }

  async function removeAlias(alias) {
    try {
      await deleteDoc(alias);
      await loadAliases();
    } catch (e) {
      error = e.message || 'Failed to delete alias.';
    }
  }

  function startEdit(alias) {
    editingId = alias._id;
    editTarget = alias.target || '';
    editDescription = alias.description || '';
  }

  function cancelEdit() {
    editingId = null;
  }

  async function saveEdit(alias) {
    try {
      await putDoc({
        _id: alias._id,
        _rev: alias._rev,
        target: editTarget.trim(),
        description: editDescription.trim()
      });
      editingId = null;
      await loadAliases();
    } catch (e) {
      error = e.message || 'Failed to update alias.';
    }
  }
</script>

<h1>Aliases</h1>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else}
  {#if error}
    <p class="error">{error}</p>
  {/if}

  <div class="card">
    <h2>Add alias</h2>
    <form on:submit|preventDefault={createAlias}>
      <div class="form-group">
        <label for="alias-addr">Address</label>
        <input id="alias-addr" type="text" bind:value={newAddress} placeholder="info@example.com" />
      </div>
      <div class="form-group">
        <label for="alias-target">Target email</label>
        <input id="alias-target" type="text" bind:value={newTarget} placeholder="user@example.com" />
      </div>
      <div class="form-group">
        <label for="alias-desc">Description (optional)</label>
        <input id="alias-desc" type="text" bind:value={newDescription} placeholder="General inquiries" />
      </div>
      {#if formError}
        <p class="error">{formError}</p>
      {/if}
      <button type="submit">Add alias</button>
    </form>
  </div>

  <div class="card">
    <h2>All aliases</h2>
    {#if aliases.length === 0}
      <p>No aliases configured.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Address</th>
            <th>Target</th>
            <th>Description</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each aliases as alias}
            <tr>
              <td>{alias._id.replace('alias-', '')}</td>
              {#if editingId === alias._id}
                <td>
                  <input type="text" bind:value={editTarget} class="edit-input" />
                </td>
                <td>
                  <input type="text" bind:value={editDescription} class="edit-input" />
                </td>
                <td class="actions">
                  <button class="btn-save" on:click={() => saveEdit(alias)}>Save</button>
                  <button class="btn-cancel" on:click={cancelEdit}>Cancel</button>
                </td>
              {:else}
                <td>{alias.target || ''}</td>
                <td>{alias.description || ''}</td>
                <td class="actions">
                  <button class="btn-edit" on:click={() => startEdit(alias)}>Edit</button>
                  <button class="btn-danger" on:click={() => removeAlias(alias)}>Delete</button>
                </td>
              {/if}
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
{/if}

<style>
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
  .edit-input {
    width: 100%;
    padding: 0.25rem 0.4rem;
    font-size: 0.9rem;
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
  .btn-edit {
    background: var(--accent);
    color: #fff;
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
    margin-right: 0.25rem;
  }
  .btn-save {
    background: #16a34a;
    color: #fff;
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
    margin-right: 0.25rem;
  }
  .btn-save:hover {
    background: #15803d;
  }
  .btn-cancel {
    background: var(--muted);
    color: #fff;
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
  }
  button[type="submit"] {
    margin-top: 0.5rem;
  }
</style>
