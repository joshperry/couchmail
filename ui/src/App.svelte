<script>
  import { onMount } from 'svelte';
  import { getSession, logout } from './lib/couch.js';
  import Login from './routes/Login.svelte';
  import Dashboard from './routes/Dashboard.svelte';
  import Settings from './routes/Settings.svelte';
  import Sieve from './routes/Sieve.svelte';
  import Users from './routes/admin/Users.svelte';
  import Domains from './routes/admin/Domains.svelte';
  import Aliases from './routes/admin/Aliases.svelte';
  import Invites from './routes/admin/Invites.svelte';
  import Register from './routes/Register.svelte';

  let route = '';
  let user = null;
  let loading = true;

  const publicRoutes = ['login', 'register'];

  const routes = {
    'login': Login,
    'register': Register,
    '': Dashboard,
    'dashboard': Dashboard,
    'settings': Settings,
    'sieve': Sieve,
    'admin/users': Users,
    'admin/domains': Domains,
    'admin/aliases': Aliases,
    'admin/invites': Invites,
  };

  function getRoute() {
    const hash = window.location.hash.replace(/^#\/?/, '');
    // Strip query string for route matching (register?token=...)
    const route = hash.split('?')[0];
    return route || '';
  }

  function navigate(path) {
    window.location.hash = '#/' + path;
  }

  async function checkSession() {
    try {
      const session = await getSession();
      if (session.userCtx && session.userCtx.name) {
        user = session.userCtx;
      } else {
        user = null;
      }
    } catch {
      user = null;
    }
  }

  async function handleLogout() {
    await logout();
    user = null;
    navigate('login');
  }

  function onHashChange() {
    route = getRoute();
    if (!user && !publicRoutes.includes(route)) {
      navigate('login');
    }
  }

  onMount(async () => {
    await checkSession();
    route = getRoute();
    if (!user && !publicRoutes.includes(route)) {
      navigate('login');
      route = 'login';
    }
    loading = false;
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  });

  function onLogin(ctx) {
    user = ctx;
    navigate('dashboard');
  }

  $: isAdmin = user && user.roles && user.roles.includes('admin');
  $: currentComponent = routes[route] || Dashboard;
</script>

{#if loading}
  <div class="container"><p>Loading...</p></div>
{:else}
  {#if user && !publicRoutes.includes(route)}
    <nav>
      <a class="brand" href="#/dashboard">CouchMail</a>
      <a href="#/dashboard">Dashboard</a>
      <a href="#/settings">Settings</a>
      <a href="#/sieve">Sieve</a>
      {#if isAdmin}
        <a href="#/admin/users">Users</a>
        <a href="#/admin/domains">Domains</a>
        <a href="#/admin/aliases">Aliases</a>
        <a href="#/admin/invites">Invites</a>
      {/if}
      <button on:click={handleLogout}>Logout</button>
    </nav>
  {/if}

  <div class="container">
    {#if route === 'login'}
      <Login on:login={(e) => onLogin(e.detail)} />
    {:else if route === 'register'}
      <Register />
    {:else}
      <svelte:component this={currentComponent} {user} />
    {/if}
  </div>
{/if}
