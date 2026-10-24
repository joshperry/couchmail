<script>
  import { onMount } from 'svelte';
  import { api, enc, isAdmin } from '../../lib/api.js';

  export let user;

  let users = [];
  let loading = true;
  let error = '';

  let newEmail = '';
  let newPassword = '';
  let newAdmin = false;
  let formError = '';

  let resetFor = null;
  let resetPassword = '';

  $: globalAdmin = isAdmin(user);

  async function loadUsers() {
    try {
      users = (await api('GET', '/admin/users')).users;
    } catch (e) {
      error = e.message || 'Failed to load users.';
    }
  }

  onMount(async () => {
    await loadUsers();
    loading = false;
  });

  function rolesOf(u) {
    const roles = [];
    if (u.isAdmin) roles.push('admin');
    if (u.adminDomains.length) roles.push(`domain admin: ${u.adminDomains.join(', ')}`);
    if (!u.hasPassword) roles.push('no password');
    return roles.join('; ') || 'user';
  }

  async function createUser() {
    formError = '';
    const address = newEmail.trim();
    if (!address) {
      formError = 'Email is required.';
      return;
    }
    if (newPassword.length < 8) {
      formError = 'Password must be at least 8 characters.';
      return;
    }
    try {
      await api('POST', '/admin/users', { address, password: newPassword, isAdmin: newAdmin });
      newEmail = '';
      newPassword = '';
      newAdmin = false;
      await loadUsers();
    } catch (e) {
      formError = e.message || 'Failed to create user.';
    }
  }

  async function removeUser(u) {
    if (!confirm(`Delete ${u.address}? Their mail stays on disk, but they can no longer log in or receive mail.`)) return;
    error = '';
    try {
      await api('DELETE', `/admin/users/${enc(u.address)}`);
      await loadUsers();
    } catch (e) {
      error = e.message || 'Failed to delete user.';
    }
  }

  async function toggleAdmin(u) {
    error = '';
    try {
      await api('PATCH', `/admin/users/${enc(u.address)}`, { isAdmin: !u.isAdmin });
      await loadUsers();
    } catch (e) {
      error = e.message || 'Failed to change admin role.';
    }
  }

  async function saveReset(u) {
    error = '';
    try {
      await api('POST', '/password', { username: u.address, new_password: resetPassword });
      resetFor = null;
      resetPassword = '';
      await loadUsers();
    } catch (e) {
      error = e.message || 'Failed to set password.';
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
      {#if globalAdmin}
        <div class="checkbox-group">
          <label>
            <input type="checkbox" bind:checked={newAdmin} />
            Admin
          </label>
        </div>
      {/if}
      {#if formError}
        <p class="error">{formError}</p>
      {/if}
      <button type="submit">Create user</button>
    </form>
  </div>

  <div class="card">
    <h2>{globalAdmin ? 'All users' : 'Users in your domains'}</h2>
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
              <td>{u.address}</td>
              <td>{rolesOf(u)}</td>
              <td class="actions">
                {#if resetFor === u.address}
                  <form class="inline-reset" on:submit|preventDefault={() => saveReset(u)}>
                    <input type="password" bind:value={resetPassword} placeholder="New password" />
                    <button type="submit">Save</button>
                    <button type="button" on:click={() => { resetFor = null; resetPassword = ''; }}>Cancel</button>
                  </form>
                {:else}
                  <button on:click={() => { resetFor = u.address; resetPassword = ''; }}>Set password</button>
                  {#if globalAdmin && u.address !== user.name}
                    <button on:click={() => toggleAdmin(u)}>{u.isAdmin ? 'Remove admin' : 'Make admin'}</button>
                  {/if}
                  {#if u.address !== user.name}
                    <button class="btn-danger" on:click={() => removeUser(u)}>Delete</button>
                  {/if}
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
  .actions button {
    font-size: 0.85rem;
    padding: 0.25rem 0.6rem;
    margin-left: 0.25rem;
  }
  .inline-reset {
    display: inline-flex;
    gap: 0.25rem;
  }
  .inline-reset button {
    margin-top: 0;
  }
  .inline-reset input {
    width: 10rem;
  }
</style>
