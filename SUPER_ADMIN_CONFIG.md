# Super Admin Configuration Guide

## Overview
As a super admin, you have full control over the entire platform. All settings are editable via the database - no hardcoded values.

## Configurable Settings

### 1. Credit Costs (`system_config.key = 'credit_costs'`)
Edit the cost per service in credits:
```json
{
  "sms": 1,
  "ai_message": 5,
  "appointment_booking": 3,
  "call": 1
}
```

### 2. LLM Providers (`system_config.key = 'llm_providers'`)
Add/remove providers and models:
```json
{
  "groq": {
    "name": "Groq",
    "models": [
      {"id": "llama3-70b-8192", "name": "Llama 3 70B", "cost_per_1k_tokens": 0.00027}
    ]
  },
  "openai": {
    "name": "OpenAI",
    "models": [
      {"id": "gpt-4", "name": "GPT-4", "cost_per_1k_tokens": 0.03}
    ]
  }
}
```

### 3. Branding (`system_config.key = 'branding'`)
Customize the entire app:
```json
{
  "app_name": "Your App Name",
  "logo_url": "https://your-cdn.com/logo.png",
  "favicon_url": "https://your-cdn.com/favicon.ico",
  "primary_color": "#3B82F6",
  "secondary_color": "#10B981",
  "footer_text": "© 2024 Your Company. All rights reserved.",
  "support_email": "support@yourcompany.com",
  "support_phone": "+1-555-123-4567"
}
```

### 4. Notifications (`system_config.key = 'notifications'`)
Configure email settings:
```json
{
  "from_name": "Your App Name",
  "from_email": "notifications@yourcompany.com",
  "welcome_subject": "Welcome to Your App",
  "low_credit_threshold": 100,
  "low_credit_subject": "Low Credit Balance Alert"
}
```

### 5. Billing (`system_config.key = 'billing'`)
Set billing parameters:
```json
{
  "currency": "USD",
  "trial_days": 14,
  "grace_period_days": 3,
  "auto_suspend_days": 7,
  "invoice_prefix": "MCR-"
}
```

### 6. Feature Flags (`system_config.key = 'features'`)
Enable/disable features:
```json
{
  "enable_byok": true,
  "enable_credits": true,
  "enable_ai": true,
  "enable_appointments": true,
  "enable_suitedash": true,
  "enable_white_label": true
}
```

## Subscription Plans
Edit the `subscription_plans` table directly:
- Change prices
- Modify included credits
- Update features
- Add/remove plans

## How to Update Config

### Via Supabase Dashboard:
1. Go to Table Editor
2. Select `system_config`
3. Find the key you want to edit
4. Update the JSON value
5. Changes apply immediately

### Via SQL:
```sql
UPDATE system_config 
SET value = '{"sms": 2, "ai_message": 10}'::jsonb
WHERE key = 'credit_costs';
```

## What Tenants Can Configure

### Per-Tenant Settings (via `tenant_llm_settings`):
- Use own API key (BYOK)
- Choose LLM provider/model
- Customize initial message
- Set system prompt
- Enable/disable auto-booking

### Per-Tenant Notifications (via `notification_settings`):
- Email notifications on/off
- SMS notifications on/off
- Which events to notify
- Notification contacts

## Super Admin Only

These can only be edited by super_admin role:
- Credit costs
- LLM provider list
- Global branding
- Subscription plans
- Feature flags
- System-wide billing settings

## No Hardcoded Values

Everything is now configurable:
- ✅ Credit costs
- ✅ LLM providers/models
- ✅ Pricing
- ✅ Branding (colors, logos, text)
- ✅ Email templates (fully editable)
- ✅ Footer copyright
- ✅ Feature availability
- ✅ Trial duration
- ✅ Invoice prefixes
- ✅ Custom metadata (unlimited flexibility)
- ✅ MintBird integration settings
- ✅ Custom SMTP configuration

## 7. MintBird Integration (`system_config.key = 'mintbird_integration'`)

Configure MintBird webhook for automatic provisioning:

```json
{
  "enabled": true,
  "webhook_secret": "your_webhook_secret_here",
  "product_mapping": {
    "mintbird_product_id_1": "Starter",
    "mintbird_product_id_2": "Growth",
    "mintbird_product_id_3": "Pro"
  },
  "auto_provision": true
}
```

**Webhook URL to add in MintBird:**
```
https://your-project.supabase.co/functions/v1/mintbird-webhook
```

### What Happens on Purchase:
1. ✅ Customer data synced from MintBird
2. ✅ Tenant account auto-created
3. ✅ Subscription plan assigned
4. ✅ Credits added based on plan
5. ✅ Login credentials generated
6. ✅ Welcome email sent (customizable template)
7. ✅ SuiteDash widget deployed (if enabled)

## 8. Custom SMTP (`system_config.key = 'smtp_settings'`)

Use your own SMTP server instead of SendGrid:

```json
{
  "host": "smtp.yourdomain.com",
  "port": 587,
  "username": "your_smtp_username",
  "password_encrypted": "encrypted_password_here",
  "from_email": "notifications@yourdomain.com",
  "from_name": "Your Company Name",
  "use_tls": true
}
```

**Supported Providers:**
- ✅ Any SMTP server
- ✅ AWS SES
- ✅ Mailgun
- ✅ Postmark
- ✅ SendGrid (default fallback)

## 9. Email Templates (`system_config.key = 'email_templates'`)

Fully customizable with **HTML/Plain Text toggle** and variable substitution:

```json
{
  "mintbird_welcome": {
    "subject": "Welcome to {{app_name}} - Your {{plan_name}} Plan is Active!",
    "format": "plain",
    "body": "Hi {{first_name}},\n\nThank you for purchasing...",
    "body_html": "<html><body><h2>Welcome!</h2><p>Hi {{first_name}},</p>...</body></html>"
  }
}
```

### Format Toggle:
- `"format": "plain"` - Sends plain text only
- `"format": "html"` - Sends HTML version (with plain text fallback)
- `"format": "both"` - Sends both versions (recommended)

### Template Structure:
```json
{
  "template_name": {
    "subject": "Email subject with {{variables}}",
    "format": "plain|html|both",
    "body": "Plain text version",
    "body_html": "<html>HTML version</html>"
  }
}
```

### Available Variables:
- `{{app_name}}` - Your app name from branding
- `{{first_name}}` - Customer first name
- `{{email}}` - Customer email
- `{{plan_name}}` - Subscription plan
- `{{credits}}` - Current credit balance
- `{{order_id}}` - MintBird order ID
- `{{temp_password}}` - Temporary login password
- `{{phone_number}}` - Caller phone number
- `{{timestamp}}` - Event timestamp

### Built-in Templates:
- `default_welcome` - Standard welcome email
- `mintbird_welcome` - Post-purchase welcome
- `low_credits` - Low balance alert
- `missed_call_alert` - New missed call notification

**Create your own templates by adding new keys!**

## 10. Custom Metadata (`super_admin_metadata` table)

Store any custom data for any entity:

```sql
-- Add custom metadata to a tenant
INSERT INTO super_admin_metadata (entity_type, entity_id, key, value, description)
VALUES (
  'tenant', 
  'tenant-uuid-here', 
  'custom_discount', 
  '{"percent": 20, "reason": "Early adopter"}',
  'Special discount for this client'
);

-- Add system-wide metadata
INSERT INTO super_admin_metadata (entity_type, key, value)
VALUES (
  'system',
  'maintenance_mode', 
  '{"enabled": false, "message": "System under maintenance"}'
);

-- Add metadata to subscription plans
INSERT INTO super_admin_metadata (entity_type, entity_id, key, value)
VALUES (
  'plan',
  'plan-uuid-here',
  'special_features',
  '["priority_support", "dedicated_ip"]'
);
```

### Use Cases for Metadata:
- Custom discounts per tenant
- Special feature flags
- Integration credentials
- A/B test configurations
- Temporary overrides
- Custom reports data
- API rate limits per tenant
- White-label customizations

### Querying Metadata:
```sql
-- Get all metadata for a tenant
SELECT * FROM super_admin_metadata 
WHERE entity_type = 'tenant' AND entity_id = 'tenant-uuid';

-- Get specific key
SELECT value FROM super_admin_metadata 
WHERE entity_type = 'system' AND key = 'maintenance_mode';
```

**You have full control + unlimited flexibility!**
