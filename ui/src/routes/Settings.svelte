<script>
  export let user;

  let newPassword = '';
  let confirmPassword = '';
  let error = '';
  let success = '';
  let submitting = false;

  async function handleSubmit() {
    error = '';
    success = '';

    if (newPassword !== confirmPassword) {
      error = 'Passwords do not match.';
      return;
    }
    if (newPassword.length < 8) {
      error = 'Password must be at least 8 characters.';
      return;
    }

    submitting = true;
    try {
      const res = await fetch('/_couchmail/api/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: user.name, new_password: newPassword })
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || 'Password change failed');
      }
      success = 'Password changed successfully.';
      newPassword = '';
      confirmPassword = '';
    } catch (e) {
      error = e.message || 'Password change failed.';
    } finally {
      submitting = false;
    }
  }
</script>

<h1>Settings</h1>

<div class="card">
  <h2>Change password</h2>
  <p class="account">Account: {user.name}</p>

  <form on:submit|preventDefault={handleSubmit}>
    <div class="form-group">
      <label for="new-password">New password</label>
      <input id="new-password" type="password" bind:value={newPassword} required />
    </div>
    <div class="form-group">
      <label for="confirm-password">Confirm password</label>
      <input id="confirm-password" type="password" bind:value={confirmPassword} required />
    </div>
    {#if error}
      <p class="error">{error}</p>
    {/if}
    {#if success}
      <p class="success">{success}</p>
    {/if}
    <button type="submit" disabled={submitting}>
      {submitting ? 'Changing...' : 'Change password'}
    </button>
  </form>
</div>

<style>
  .account {
    color: var(--muted);
    margin-bottom: 1rem;
  }
  .success {
    color: #16a34a;
    margin-top: 0.5rem;
  }
  button[type="submit"] {
    margin-top: 0.5rem;
  }
</style>
