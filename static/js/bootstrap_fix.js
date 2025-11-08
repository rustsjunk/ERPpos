// Safety net to ensure login controls remain clickable even if earlier JS failed to bind
(function(){
  function wireLogin(){
    try {
      const enter = document.getElementById('loginEnterBtn');
      const code = document.getElementById('cashierCodeInput');
      if (enter && enter.dataset.bound !== '1'){
        enter.addEventListener('click', function(){ try{ if(typeof attemptLogin==='function'){ attemptLogin(); } }catch(e){ console.error('[POS] attemptLogin failed', e); } });
        enter.dataset.bound = '1';
      }
      if (code && code.dataset.bound !== '1'){
        code.addEventListener('keydown', function(e){ if(e.key==='Enter'){ try{ if(typeof attemptLogin==='function'){ attemptLogin(); } }catch(err){ console.error('[POS] attemptLogin enter failed', err);} } });
        code.dataset.bound = '1';
      }
    } catch (e) { /* ignore */ }
  }
  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', wireLogin);
  } else {
    wireLogin();
  }
  // Try again shortly in case DOM updated later
  setTimeout(wireLogin, 500);
  setTimeout(wireLogin, 1500);
})();

