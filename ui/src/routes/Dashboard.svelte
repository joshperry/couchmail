<script>
  import { onMount } from 'svelte';
  import { getDoc, allDocs } from '../lib/couch.js';

  export let user;

  let userDoc = null;
  let aliases = [];
  let loading = true;
  let error = '';

  $: isAdmin = user && user.roles && user.roles.includes('admin');

  onMount(async () => {
    try {
      const [docResult, aliasResult] = await Promise.all([
        getDoc('org.couchdb.user:' + user.name).catch(() => null),
        allDocs({ startkey: 'alias-', endkey: 'alias-\ufff0', include_docs: true }).catch(() => ({ rows: [] }))
      ]);
      userDoc = docResult;
      aliases = (aliasResult.rows || [])
        .map(r => r.doc)
        .filter(d => d && d.target === user.name);
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
    <h2>Welcome, {user.name}</h2>
    {#if userDoc && userDoc.domain}
      <p>Domain: <strong>{userDoc.domain}</strong></p>
    {/if}
  </div>

  <div class="card">
    <h2>Your aliases</h2>
    {#if aliases.length === 0}
      <p>No aliases point to your account.</p>
    {:else}
      <ul>
        {#each aliases as alias}
          <li>
            <strong>{alias._id.replace('alias-', '')}</strong>
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
