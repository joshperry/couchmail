<script>
  let token = '';
  let email = '';
  let password = '';
  let confirmPassword = '';
  let error = '';
  let success = false;
  let submitting = false;

  // Parse token from URL hash query string
  function getToken() {
    const hash = window.location.hash;
    const qmark = hash.indexOf('?');
    if (qmark === -1) return '';
    const params = new URLSearchParams(hash.slice(qmark + 1));
    return params.get('token') || '';
  }

  token = getToken();

  async function handleSubmit() {
    error = '';
    if (!token) {
      error = 'No invite token provided.';
      return;
    }
    if (!email) {
      error = 'Email is required.';
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

    submitting = true;
    try {
      const res = await fetch('/_couchmail/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, name: email, password })
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

    {#if success}
      <p class="success">Account created. You can now <a href="#/login">sign in</a>.</p>
    {:else if !token}
      <p class="error">No invite token found. You need a valid invite link to register.</p>
    {:else}
      <form on:submit|preventDefault={handleSubmit}>
        <div class="form-group">
          <label for="reg-email">Email</label>
          <input id="reg-email" type="text" bind:value={email} placeholder="you@example.com" required />
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
