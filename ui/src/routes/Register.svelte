<script>
  import { onMount } from 'svelte';

  let token = '';
  let domain = '';
  let username = '';
  let password = '';
  let confirmPassword = '';
  let error = '';
  let tokenError = '';
  let success = false;
  let submitting = false;
  let loading = true;

  function getToken() {
    const hash = window.location.hash;
    const qmark = hash.indexOf('?');
    if (qmark === -1) return '';
    const params = new URLSearchParams(hash.slice(qmark + 1));
    return params.get('token') || '';
  }

  onMount(async () => {
    token = getToken();
    if (!token) {
      tokenError = 'No invite token found. You need a valid invite link to register.';
      loading = false;
      return;
    }
    try {
      const res = await fetch(`/_couchmail/api/register?token=${encodeURIComponent(token)}`);
      const data = await res.json();
      if (!res.ok) {
        tokenError = data.error || 'Invalid invite token.';
      } else {
        domain = data.domain;
      }
    } catch {
      tokenError = 'Could not validate invite token.';
    }
    loading = false;
  });

  async function handleSubmit() {
    error = '';
    if (!username.trim()) {
      error = 'Username is required.';
      return;
    }
    if (password.length < 8) {
      error = 'Password must be at least 8 characters.';
      return;
    }
    if (password !== confirmPassword) {
      error = 'Passwords do not match.';
      return;
    }

    const name = username.trim() + '@' + domain;
    submitting = true;
    try {
      const res = await fetch('/_couchmail/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name, password })
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Registration failed');
      }
      success = true;
    } catch (e) {
      error = e.message || 'Registration failed.';
    } finally {
      submitting = false;
    }
  }
</script>

<div class="register-wrapper">
  <div class="card">
    <h1>Create Account</h1>

    {#if loading}
      <p>Validating invite...</p>
    {:else if success}
      <p class="success">Account created. You can now <a href="#/login">sign in</a>.</p>
    {:else if tokenError}
      <p class="error">{tokenError}</p>
    {:else}
      <form on:submit|preventDefault={handleSubmit}>
        <div class="form-group">
          <label for="reg-username">Username</label>
          <div class="email-field">
            <input id="reg-username" type="text" bind:value={username} placeholder="you" required />
            <span class="domain-suffix">@{domain}</span>
          </div>
        </div>
        <div class="form-group">
          <label for="reg-password">Password</label>
          <input id="reg-password" type="password" bind:value={password} required />
        </div>
        <div class="form-group">
          <label for="reg-confirm">Confirm password</label>
          <input id="reg-confirm" type="password" bind:value={confirmPassword} required />
        </div>
        {#if error}
          <p class="error">{error}</p>
        {/if}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creating account...' : 'Create account'}
        </button>
      </form>
    {/if}
  </div>
</div>

<style>
  .register-wrapper {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 80vh;
  }
  .register-wrapper .card {
    width: 100%;
    max-width: 400px;
  }
  .register-wrapper h1 {
    text-align: center;
  }
  .email-field {
    display: flex;
    align-items: center;
    gap: 0;
  }
  .email-field input {
    flex: 1;
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
    border-right: none;
  }
  .domain-suffix {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-left: none;
    border-radius: 0 4px 4px 0;
    background: var(--surface);
    color: var(--muted);
    white-space: nowrap;
    font-size: 0.95rem;
  }
  .success {
    color: #16a34a;
    text-align: center;
    margin-top: 1rem;
  }
  .success a {
    color: var(--accent);
  }
  button[type="submit"] {
    width: 100%;
    margin-top: 0.5rem;
  }
</style>
