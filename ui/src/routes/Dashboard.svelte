<script>
  export let user;

  $: isAdmin = user && user.roles && user.roles.includes('admin');
</script>

<h1>Dashboard</h1>

<div class="card">
  <h2>Welcome, {user?.name || 'user'}</h2>
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
