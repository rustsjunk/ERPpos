from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
import requests
import os
from datetime import datetime
from uuid import uuid4

# Load environment variables
load_dotenv()

app = Flask(__name__)

# Behavior flags
USE_MOCK = os.getenv('USE_MOCK', '1') == '1'  # default to mock POS with no ERP dependency

# ERPNext API configuration (used only if USE_MOCK is False)
ERPNEXT_URL = os.getenv('ERPNEXT_URL')
API_KEY = os.getenv('ERPNEXT_API_KEY')
API_SECRET = os.getenv('ERPNEXT_API_SECRET')


def _erp_headers():
    if not ERPNEXT_URL or not API_KEY or not API_SECRET:
        raise RuntimeError("Missing ERPNEXT_URL/ERPNEXT_API_KEY/ERPNEXT_API_SECRET in environment")
    return {
        'Authorization': f'token {API_KEY}:{API_SECRET}',
        'Content-Type': 'application/json'
    }


def _error_message_from_response(resp: requests.Response) -> str:
    try:
        j = resp.json()
        return j.get('message') or j.get('exception') or resp.text
    except Exception:
        return resp.text


@app.route('/')
def index():
    """Render the main POS interface"""
    return render_template('pos.html')


@app.route('/api/items')
def get_items():
    """Get all items"""
    if USE_MOCK:
        # Mock catalog: shoes with brands
        items = [
            {"name": "SHOE-ATH-001", "item_name": "Runner Pro", "brand": "Stride", "standard_rate": 59.99, "stock_uom": "Pair", "image": None},
            {"name": "SHOE-ATH-002", "item_name": "Trail Master", "brand": "Stride", "standard_rate": 69.99, "stock_uom": "Pair", "image": None},
            {"name": "SHOE-CAS-001", "item_name": "Everyday Comfort", "brand": "ComfortStep", "standard_rate": 49.99, "stock_uom": "Pair", "image": None},
            {"name": "SHOE-CAS-002", "item_name": "Urban Walk", "brand": "ComfortStep", "standard_rate": 54.99, "stock_uom": "Pair", "image": None},
            {"name": "SHOE-DRS-001", "item_name": "Oxford Classic", "brand": "Elegance", "standard_rate": 79.99, "stock_uom": "Pair", "image": None},
            {"name": "SHOE-DRS-002", "item_name": "Derby Prime", "brand": "Elegance", "standard_rate": 84.99, "stock_uom": "Pair", "image": None},
            {"name": "SHOE-KID-001", "item_name": "Playtime Sneaker", "brand": "LittleFeet", "standard_rate": 39.99, "stock_uom": "Pair", "image": None},
            {"name": "SHOE-KID-002", "item_name": "School Buddy", "brand": "LittleFeet", "standard_rate": 34.99, "stock_uom": "Pair", "image": None}
        ]
        return jsonify({'status': 'success', 'items': items})
    try:
        response = requests.get(
            f"{ERPNEXT_URL}/api/resource/Item",
            headers=_erp_headers(),
            params={
                'fields': '["name", "item_name", "brand", "image", "standard_rate", "stock_uom"]',
                'filters': '[["is_sales_item","=",1],["disabled","=",0]]'
            },
            timeout=15
        )
        response.raise_for_status()
        items = response.json().get('data', [])
        return jsonify({'status': 'success', 'items': items})
    except requests.HTTPError as e:
        return jsonify({'status': 'error', 'message': _error_message_from_response(e.response)}), e.response.status_code if e.response else 500
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/create-sale', methods=['POST'])
def create_sale():
    """Create a sales invoice"""
    if USE_MOCK:
        data = request.json or {}
        if not data.get('customer'):
            return jsonify({'status': 'error', 'message': 'Customer is required'}), 400
        if not data.get('items'):
            return jsonify({'status': 'error', 'message': 'Items are required'}), 400
        invoice_name = f"MOCK-{datetime.now().strftime('%Y%m%d')}-{uuid4().hex[:8].upper()}"
        return jsonify({'status': 'success', 'message': 'Sale recorded (mock)', 'invoice_name': invoice_name})
    try:
        data = request.json
        invoice_data = {
            'doctype': 'Sales Invoice',
            'customer': data['customer'],
            'posting_date': datetime.now().strftime('%Y-%m-%d'),
            'items': data['items'],
            'is_pos': 1,
            'payments': data['payments']
        }
        # Create invoice
        response = requests.post(
            f"{ERPNEXT_URL}/api/resource/Sales Invoice",
            headers=_erp_headers(),
            json=invoice_data,
            timeout=20
        )
        response.raise_for_status()
        invoice = response.json().get('data', {})

        # Submit invoice
        submit_response = requests.post(
            f"{ERPNEXT_URL}/api/method/frappe.client.submit",
            headers=_erp_headers(),
            json={'doctype': 'Sales Invoice', 'name': invoice['name']},
            timeout=20
        )
        submit_response.raise_for_status()

        return jsonify({'status': 'success', 'message': 'Sale completed successfully', 'invoice_name': invoice['name']})
    except requests.HTTPError as e:
        return jsonify({'status': 'error', 'message': _error_message_from_response(e.response)}), e.response.status_code if e.response else 500
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/customers')
def get_customers():
    """Get all customers"""
    if USE_MOCK:
        customers = [
            {"name": "CUST-WALKIN", "customer_name": "Walk-in Customer"},
            {"name": "CUST-ALPHA", "customer_name": "Alpha Ltd"},
            {"name": "CUST-BETA", "customer_name": "Beta Inc"},
            {"name": "CUST-JDOE", "customer_name": "John Doe"}
        ]
        return jsonify({'status': 'success', 'customers': customers})
    try:
        response = requests.get(
            f"{ERPNEXT_URL}/api/resource/Customer",
            headers=_erp_headers(),
            params={
                'fields': '["name", "customer_name"]',
                'filters': '[["disabled","=",0]]'
            },
            timeout=15
        )
        response.raise_for_status()
        customers = response.json().get('data', [])
        return jsonify({'status': 'success', 'customers': customers})
    except requests.HTTPError as e:
        return jsonify({'status': 'error', 'message': _error_message_from_response(e.response)}), e.response.status_code if e.response else 500
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


@app.route('/api/item_matrix')
def item_matrix():
    """Return a variant matrix for a given item (mock-first)."""
    item_name = request.args.get('item')
    if not item_name:
        return jsonify({'status': 'error', 'message': 'Missing item parameter'}), 400
    if USE_MOCK:
        sizes = [3, 4, 5, 6, 7]
        colors = ['Brown', 'Black']
        widths = ['Standard', 'Wide Fitting']
        stock = {}
        for c in colors:
            for w in widths:
                for s in sizes:
                    stock[f"{c}|{w}|{s}"] = (s % 3) + (1 if w.startswith('Wide') else 0)
        price = 49.99
        image = None
        return jsonify({'status': 'success', 'data': {
            'item': item_name,
            'sizes': sizes,
            'colors': colors,
            'widths': widths,
            'stock': stock,
            'price': price,
            'image': image
        }})
    return jsonify({'status': 'error', 'message': 'Variant matrix not implemented for ERP mode'}), 501


if __name__ == '__main__':
    debug = os.getenv('FLASK_DEBUG', '0') == '1'
    port = int(os.getenv('PORT', '5000'))
    host = os.getenv('HOST', '0.0.0.0')
    app.run(host=host, port=port, debug=debug)


