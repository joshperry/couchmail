<script>
  import { createEventDispatcher } from 'svelte';
  import { login, getSession } from '../lib/couch.js';

  const dispatch = createEventDispatcher();

  let email = '';
  let password = '';
  let error = '';
  let submitting = false;

  async function handleSubmit() {
    error = '';
    submitting = true;
    try {
      await login(email, password);
      const session = await getSession();
      dispatch('login', session.userCtx);
    } catch (e) {
      error = 'Invalid email or password.';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="login-wrapper">
  <div class="card">
    <h1>CouchMail</h1>
    <form on:submit|preventDefault={handleSubmit}>
      <div class="form-group">
        <label for="email">Email</label>
        <input id="email" type="text" bind:value={email} placeholder="user@example.com" required />
      </div>
      <div class="form-group">
        <label for="password">Password</label>
        <input id="password" type="password" bind:value={password} required />
      </div>
      {#if error}
        <p class="error">{error}</p>
      {/if}
      <button type="submit" disabled={submitting}>
        {submitting ? 'Signing in...' : 'Sign in'}
      </button>
    </form>
  </div>
</div>

<style>
  .login-wrapper {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 80vh;
  }
  .login-wrapper .card {
    width: 100%;
    max-width: 400px;
  }
  .login-wrapper h1 {
    text-align: center;
  }
  button[type="submit"] {
    width: 100%;
    margin-top: 0.5rem;
  }
</style>
