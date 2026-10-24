<script>
  import { onMount } from 'svelte';
  import { api, canAdminister } from '../lib/api.js';

  export let user;

  let me = null;
  let loading = true;
  let error = '';

  $: isAdmin = canAdminister(user);

  onMount(async () => {
    try {
      me = await api('GET', '/me');
    } catch (e) {
      error = 'Failed to load dashboard data.';
    } finally {
      loading = false;
    }
  });
</script>

<h1>Dashboard</h1>

{#if loading}
  <div class="card"><p>Loading...</p></div>
{:else if error}
  <div class="card"><p class="error">{error}</p></div>
{:else}
  <div class="card">
    <h2>Welcome, {me.name}</h2>
    <p>Domain: <strong>{me.domain}</strong></p>
    {#if me.adminDomains.length}
      <p>You administer: <strong>{me.adminDomains.join(', ')}</strong></p>
    {/if}
  </div>

  <div class="card">
    <h2>Your aliases</h2>
    {#if me.aliases.length === 0}
      <p>No aliases point to your account.</p>
    {:else}
      <ul>
        {#each me.aliases as alias}
          <li>
            <strong>{alias.address}</strong>
            {#if alias.description}&mdash; {alias.description}{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="card">
    <h2>Quick links</h2>
    <div class="links">
      <a href="#/settings">Settings</a>
      <a href="#/sieve">Sieve Filters</a>
    </div>
  </div>

  {#if isAdmin}
    <div class="card">
      <h2>Administration</h2>
      <div class="links">
        <a href="#/admin/users">Users</a>
        <a href="#/admin/domains">Domains</a>
        <a href="#/admin/aliases">Aliases</a>
        <a href="#/admin/invites">Invites</a>
      </div>
    </div>
  {/if}
{/if}

<style>
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border);
  }
  li:last-child {
    border-bottom: none;
  }
</style>
