<script>
  import { onMount } from 'svelte';
  import { allDocs, putDoc, deleteDoc } from '../../lib/couch.js';

  export let user;

  let users = [];
  let loading = true;
  let error = '';

  let newEmail = '';
  let newPassword = '';
  let newAdmin = false;
  let formError = '';

  async function loadUsers() {
    try {
      const result = await allDocs({
        startkey: 'org.couchdb.user:',
        endkey: 'org.couchdb.user:\ufff0',
        include_docs: true
      });
      users = (result.rows || []).map(r => r.doc);
    } catch (e) {
      error = 'Failed to load users.';
    }
  }

  onMount(async () => {
    await loadUsers();
    loading = false;
  });

  async function createUser() {
    formError = '';
    const email = newEmail.trim();
    if (!email) {
      formError = 'Email is required.';
      return;
    }
    if (!newPassword) {
      formError = 'Password is required.';
      return;
    }
    const roles = newAdmin ? ['admin'] : [];
    try {
      await putDoc({
        _id: 'org.couchdb.user:' + email,
        name: email,
        type: 'user',
        roles,
        password: newPassword,
        dovecot_password: ''
      });
      newEmail = '';
      newPassword = '';
      newAdmin = false;
      await loadUsers();
    } catch (e) {
      formError = e.message || 'Failed to create user.';
    }
  }

  async function removeUser(u) {
    try {
      await deleteDoc(u);
      await loadUsers();
    } catch (e) {
      error = e.message || 'Failed to delete user.';
    }
  }
</script>

<h1>Users</h1>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else}
  {#if error}
    <p class="error">{error}</p>
  {/if}

  <div class="card">
    <h2>Create user</h2>
    <form on:submit|preventDefault={createUser}>
      <div class="form-group">
        <label for="new-email">Email</label>
        <input id="new-email" type="text" bind:value={newEmail} placeholder="user@example.com" />
      </div>
      <div class="form-group">
        <label for="new-pw">Password</label>
        <input id="new-pw" type="password" bind:value={newPassword} />
      </div>
      <div class="checkbox-group">
        <label>
          <input type="checkbox" bind:checked={newAdmin} />
          Admin
        </label>
      </div>
      {#if formError}
        <p class="error">{formError}</p>
      {/if}
      <button type="submit">Create user</button>
    </form>
  </div>

  <div class="card">
    <h2>All users</h2>
    {#if users.length === 0}
      <p>No users found.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>Roles</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each users as u}
            <tr>
              <td>{u.name}</td>
              <td>{(u.roles || []).join(', ') || 'user'}</td>
              <td class="actions">
                <button class="btn-danger" on:click={() => removeUser(u)}>Delete</button>
              </td>
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
  .checkbox-group {
    margin-bottom: 1rem;
  }
  .checkbox-group label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
  }
  .checkbox-group input[type="checkbox"] {
    width: auto;
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
  button[type="submit"] {
    margin-top: 0.5rem;
  }
</style>
