import os
import subprocess
import sys
from pos_server import app, start_background_services


def start_receipt_agent():
    if os.getenv('RECEIPT_AGENT_AUTO_START', '0') != '1':
        return None
    script_path = os.path.join(os.path.dirname(__file__), 'receipt_agent.py')
    if not os.path.exists(script_path):
        return None
    env = os.environ.copy()
    env.setdefault('RECEIPT_AGENT_HOST', '127.0.0.1')
    env.setdefault('RECEIPT_AGENT_PORT', '5001')
    return subprocess.Popen([sys.executable, script_path], env=env)


def start_till_agent():
    if os.getenv('TILL_AGENT_AUTO_START', '0') != '1':
        return None
    script_path = os.path.join(os.path.dirname(__file__), 'till_agent.py')
    if not os.path.exists(script_path):
        return None
    env = os.environ.copy()
    env.setdefault('INVOICES_DIR', os.path.join(os.getcwd(), 'invoices'))
    if not env.get('TILL_POST_URL'):
        erpdash_url = (env.get('ERPDASH_URL') or '').rstrip('/')
        if erpdash_url:
            env['TILL_POST_URL'] = f"{erpdash_url}/api/pos/sales"
        else:
            host = env.get('HOST', '127.0.0.1')
            port = env.get('PORT', '5000')
            if host in ('0.0.0.0', '::'):
                host = '127.0.0.1'
            env['TILL_POST_URL'] = f"http://{host}:{port}/api/pos/sales"
    return subprocess.Popen([sys.executable, script_path], env=env)


if __name__ == '__main__':
    from waitress import serve

    port = int(os.getenv('PORT', '5000'))
    host = os.getenv('HOST', '0.0.0.0')
    threads = int(os.getenv('WAITRESS_THREADS', '4'))

    start_background_services()
    agent_proc = start_receipt_agent()
    till_agent_proc = start_till_agent()
    try:
        print(f" * Serving erppos on http://{host}:{port} (waitress, {threads} threads)")
        serve(app, host=host, port=port, threads=threads)
    finally:
        for proc in (agent_proc, till_agent_proc):
            if proc:
                proc.terminate()
