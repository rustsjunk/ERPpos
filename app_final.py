from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
import requests
import os
from datetime import datetime

# Load environment variables
load_dotenv()

app = Flask(__name__)

# ERPNext API configuration
ERPNEXT_URL = os.getenv('ERPNEXT_URL')
API_KEY = os.getenv('ERPNEXT_API_KEY')
API_SECRET = os.getenv('ERPNEXT_API_SECRET')
HEADERS = {
    'Authorization': f'token {API_KEY}:{API_SECRET}',
    'Content-Type': 'application/json'
}

@app.route('/')
def index():
    """Render the main POS interface"""
    return render_template('pos.html')

@app.route('/api/items')
def get_items():
    """Get all items from ERPNext"""
    try:
        response = requests.get(
            f"{ERPNEXT_URL}/api/resource/Item",
            headers=HEADERS,
            params={
                'fields': '["name", "item_name", "standard_rate", "stock_uom"]',
                'filters': '[["is_sales_item","=",1],["disabled","=",0]]'
            }
        )
        response.raise_for_status()
        items = response.json().get('data', [])
        return jsonify({'status': 'success', 'items': items})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/api/create-sale', methods=['POST'])
def create_sale():
    """Create a sales invoice in ERPNext"""
    try:
        data = request.json
        
        # Create sales invoice
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
            headers=HEADERS,
            json=invoice_data
        )
        response.raise_for_status()
        invoice = response.json().get('data', {})
        
        # Submit invoice
        submit_response = requests.post(
            f"{ERPNEXT_URL}/api/resource/Sales Invoice/{invoice['name']}/submit",
            headers=HEADERS
        )
        submit_response.raise_for_status()
        
        return jsonify({
            'status': 'success',
            'message': 'Sale completed successfully',
            'invoice_name': invoice['name']
        })
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

@app.route('/api/customers')
def get_customers():
    """Get all customers from ERPNext"""
    try:
        response = requests.get(
            f"{ERPNEXT_URL}/api/resource/Customer",
            headers=HEADERS,
            params={
                'fields': '["name", "customer_name"]',
                'filters': '[["disabled","=",0]]'
            }
        )
        response.raise_for_status()
        customers = response.json().get('data', [])
        return jsonify({'status': 'success', 'customers': customers})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

if __name__ == '__main__':
    app.run(debug=True)