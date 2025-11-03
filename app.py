from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv
import os
import frappe
from datetime import datetime

# Load environment variables
load_dotenv()

app = Flask(__name__)

def init_frappe():
    """Initialize Frappe connection"""
    frappe.connect(
        url=os.getenv('ERPNEXT_URL'),
        token=f"{os.getenv('ERPNEXT_API_KEY')}:{os.getenv('ERPNEXT_API_SECRET')}"
    )

@app.before_first_request
def before_first_request():
    """Initialize Frappe before first request"""
    init_frappe()
    url=os.getenv('ERPNEXT_URL'),
    api_key=os.getenv('ERPNEXT_API_KEY'),
    api_secret=os.getenv('ERPNEXT_API_SECRET')
)

@app.route('/')
def index():
    """Render the main POS interface"""
    return render_template('pos.html')

@app.route('/api/items')
def get_items():
    """Get all items from ERPNext"""
    try:
        items = frappe.get_list('Item', 
                              fields=['name', 'item_name', 'standard_rate', 'stock_uom'],
                              filters={'is_sales_item': 1, 'disabled': 0})
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
        
        invoice = frappe.insert(invoice_data)
        
        # Submit the invoice
        frappe.submit(invoice)
        
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
        customers = frappe.get_list('Customer',
                                  fields=['name', 'customer_name'],
                                  filters={'disabled': 0})
        return jsonify({'status': 'success', 'customers': customers})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)})

if __name__ == '__main__':
    app.run(debug=True)