-- ============================================
-- MIGRATION: Hybrid LLM + SuiteDash Auto-Sync + Billing
-- Run this in Supabase SQL Editor
-- ============================================

-- ============================================
-- PART 1: CREDIT SYSTEM
-- ============================================

-- Credit balances per tenant
CREATE TABLE IF NOT EXISTS credit_balances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    balance INTEGER DEFAULT 0,
    lifetime_credits INTEGER DEFAULT 0,
    lifetime_spent INTEGER DEFAULT 0,
    warning_threshold INTEGER DEFAULT 100,
    auto_recharge BOOLEAN DEFAULT FALSE,
    auto_recharge_amount INTEGER DEFAULT 500,
    last_recharge_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id)
);

-- Credit transactions history
CREATE TABLE IF NOT EXISTS credit_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    type TEXT NOT NULL, -- 'purchase', 'usage', 'bonus', 'refund'
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Usage tracking for billing
CREATE TABLE IF NOT EXISTS usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    service_type TEXT NOT NULL, -- 'sms', 'ai_conversation', 'appointment', 'call'
    credits_used INTEGER NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE credit_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY credit_balance_tenant_isolation ON credit_balances FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

CREATE POLICY credit_transaction_tenant_isolation ON credit_transactions FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

CREATE POLICY usage_logs_tenant_isolation ON usage_logs FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

-- Indexes
CREATE INDEX idx_credit_transactions_tenant ON credit_transactions(tenant_id, created_at DESC);
CREATE INDEX idx_usage_logs_tenant ON usage_logs(tenant_id, created_at DESC);
CREATE INDEX idx_usage_logs_service ON usage_logs(tenant_id, service_type, created_at);

-- ============================================
-- PART 2: TENANT LLM SETTINGS
-- ============================================

CREATE TABLE IF NOT EXISTS tenant_llm_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- LLM Provider Settings
    use_own_key BOOLEAN DEFAULT FALSE,
    provider TEXT DEFAULT 'groq', -- 'openai', 'anthropic', 'groq', 'kimi'
    model TEXT DEFAULT 'llama3-70b-8192', -- model name per provider
    api_key_encrypted TEXT, -- encrypted API key for BYOK
    
    -- Fallback Settings
    fallback_to_credits BOOLEAN DEFAULT TRUE,
    fallback_provider TEXT DEFAULT 'groq',
    fallback_model TEXT DEFAULT 'llama3-70b-8192',
    
    -- AI Behavior
    initial_message TEXT DEFAULT 'Sorry we missed your call! We''re here now - what can we help you with?',
    system_prompt TEXT DEFAULT 'You are a helpful assistant for a business. Your goal is to qualify leads and book appointments. Be friendly, professional, and concise.',
    max_conversation_length INTEGER DEFAULT 20,
    auto_book_appointments BOOLEAN DEFAULT TRUE,
    
    -- Cost Controls
    max_tokens_per_message INTEGER DEFAULT 500,
    temperature DECIMAL(3,2) DEFAULT 0.7,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id)
);

-- Enable RLS
ALTER TABLE tenant_llm_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_llm_settings_isolation ON tenant_llm_settings FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

-- ============================================
-- PART 3: LLM CONVERSATIONS
-- ============================================

CREATE TABLE IF NOT EXISTS llm_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    lead_id UUID REFERENCES leads(id),
    phone_number TEXT NOT NULL,
    
    -- Conversation State
    status TEXT DEFAULT 'active', -- 'active', 'completed', 'timeout', 'error'
    context JSONB DEFAULT '[]', -- message history
    lead_qualified BOOLEAN DEFAULT FALSE,
    appointment_requested BOOLEAN DEFAULT FALSE,
    appointment_booked BOOLEAN DEFAULT FALSE,
    appointment_details JSONB,
    
    -- AI Metadata
    provider_used TEXT,
    model_used TEXT,
    credits_used INTEGER DEFAULT 0,
    tokens_used INTEGER DEFAULT 0,
    
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE llm_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY llm_conversation_tenant_isolation ON llm_conversations FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

CREATE INDEX idx_llm_conversations_tenant ON llm_conversations(tenant_id, created_at DESC);
CREATE INDEX idx_llm_conversations_lead ON llm_conversations(lead_id);
CREATE INDEX idx_llm_conversations_active ON llm_conversations(tenant_id, status) WHERE status = 'active';

-- ============================================
-- PART 4: SUITEDASH SYNC
-- ============================================

-- SuiteDash integration settings per tenant
CREATE TABLE IF NOT EXISTS suitedash_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- SuiteDash Connection
    suitedash_client_id TEXT,
    suitedash_api_key TEXT,
    suitedash_portal_url TEXT,
    
    -- Auto-Sync Settings
    auto_sync_enabled BOOLEAN DEFAULT FALSE,
    widget_deployed BOOLEAN DEFAULT FALSE,
    widget_position TEXT DEFAULT 'dashboard_top',
    
    -- Sync Status
    last_sync_at TIMESTAMPTZ,
    sync_status TEXT DEFAULT 'pending', -- 'pending', 'active', 'error'
    sync_error TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id)
);

-- SuiteDash webhook events log
CREATE TABLE IF NOT EXISTS suitedash_webhook_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    event_type TEXT NOT NULL,
    payload JSONB,
    processed BOOLEAN DEFAULT FALSE,
    error TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE suitedash_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE suitedash_webhook_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY suitedash_integration_isolation ON suitedash_integrations FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

CREATE POLICY suitedash_webhook_logs_isolation ON suitedash_webhook_logs FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

-- ============================================
-- PART 5: BILLING & SUBSCRIPTIONS
-- ============================================

-- Subscription plans
CREATE TABLE IF NOT EXISTS subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL,
    interval TEXT DEFAULT 'month', -- 'month', 'year'
    included_credits INTEGER DEFAULT 0,
    features JSONB DEFAULT '[]',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tenant subscriptions
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id UUID REFERENCES subscription_plans(id),
    
    -- Subscription Status
    status TEXT DEFAULT 'active', -- 'active', 'cancelled', 'past_due', 'trialing'
    current_period_start TIMESTAMPTZ,
    current_period_end TIMESTAMPTZ,
    
    -- Billing
    stripe_subscription_id TEXT,
    stripe_customer_id TEXT,
    
    -- Overage Settings
    overage_enabled BOOLEAN DEFAULT TRUE,
    overage_rate DECIMAL(10,4) DEFAULT 0.05, -- per credit
    overage_threshold INTEGER DEFAULT 100, -- alert at this many credits
    auto_bill_overage BOOLEAN DEFAULT TRUE,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id)
);

-- Billing invoices
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    invoice_number TEXT UNIQUE,
    type TEXT DEFAULT 'subscription', -- 'subscription', 'overage', 'one_time'
    amount DECIMAL(10,2) NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'paid', 'failed', 'refunded'
    
    -- Details
    description TEXT,
    line_items JSONB DEFAULT '[]',
    credits_purchased INTEGER,
    
    -- Stripe
    stripe_invoice_id TEXT,
    stripe_payment_intent_id TEXT,
    
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE subscription_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY subscription_plans_select ON subscription_plans FOR SELECT USING (true);
CREATE POLICY subscription_plans_admin ON subscription_plans FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);
CREATE POLICY tenant_subscription_isolation ON tenant_subscriptions FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);
CREATE POLICY invoice_tenant_isolation ON invoices FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

-- Insert default plans
INSERT INTO subscription_plans (name, description, price, included_credits, features) VALUES
('Starter', 'Perfect for small businesses', 49.00, 500, '["missed_call_sms", "ai_conversations", "basic_analytics"]'),
('Growth', 'For growing businesses', 99.00, 1500, '["missed_call_sms", "ai_conversations", "appointment_booking", "advanced_analytics", "suitedash_integration"]'),
('Pro', 'For agencies and high-volume', 199.00, 5000, '["missed_call_sms", "ai_conversations", "appointment_booking", "white_label", "api_access", "priority_support"]');

-- ============================================
-- PART 6: NOTIFICATIONS
-- ============================================

-- Client notification preferences
CREATE TABLE IF NOT EXISTS notification_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- Channels
    email_notifications BOOLEAN DEFAULT TRUE,
    sms_notifications BOOLEAN DEFAULT TRUE,
    webhook_notifications BOOLEAN DEFAULT FALSE,
    
    -- Events
    notify_on_missed_call BOOLEAN DEFAULT TRUE,
    notify_on_new_lead BOOLEAN DEFAULT TRUE,
    notify_on_appointment BOOLEAN DEFAULT TRUE,
    notify_on_ai_conversation BOOLEAN DEFAULT FALSE,
    notify_on_low_credits BOOLEAN DEFAULT TRUE,
    
    -- Contact Info
    notification_email TEXT,
    notification_phone TEXT,
    webhook_url TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id)
);

-- Notification queue
CREATE TABLE IF NOT EXISTS notification_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    type TEXT NOT NULL, -- 'email', 'sms', 'webhook'
    recipient TEXT NOT NULL,
    subject TEXT,
    content TEXT,
    status TEXT DEFAULT 'pending', -- 'pending', 'sent', 'failed'
    
    error TEXT,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_settings_isolation ON notification_settings FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

CREATE POLICY notification_queue_isolation ON notification_queue FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

-- ============================================
-- PART 7: FUNCTIONS & TRIGGERS
-- ============================================

-- Function to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply update triggers
CREATE TRIGGER update_credit_balances_updated_at BEFORE UPDATE ON credit_balances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tenant_llm_settings_updated_at BEFORE UPDATE ON tenant_llm_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_suitedash_integrations_updated_at BEFORE UPDATE ON suitedash_integrations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_tenant_subscriptions_updated_at BEFORE UPDATE ON tenant_subscriptions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_notification_settings_updated_at BEFORE UPDATE ON notification_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to deduct credits
CREATE OR REPLACE FUNCTION deduct_credits(
    p_tenant_id UUID,
    p_amount INTEGER,
    p_description TEXT,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS BOOLEAN AS $$
DECLARE
    v_current_balance INTEGER;
    v_new_balance INTEGER;
BEGIN
    -- Get current balance
    SELECT balance INTO v_current_balance
    FROM credit_balances
    WHERE tenant_id = p_tenant_id;
    
    IF v_current_balance IS NULL OR v_current_balance < p_amount THEN
        RETURN FALSE; -- Insufficient credits
    END IF;
    
    -- Calculate new balance
    v_new_balance := v_current_balance - p_amount;
    
    -- Update balance
    UPDATE credit_balances
    SET balance = v_new_balance,
        lifetime_spent = lifetime_spent + p_amount,
        updated_at = NOW()
    WHERE tenant_id = p_tenant_id;
    
    -- Log transaction
    INSERT INTO credit_transactions (tenant_id, type, amount, balance_after, description, metadata)
    VALUES (p_tenant_id, 'usage', p_amount, v_new_balance, p_description, p_metadata);
    
    RETURN TRUE;
END;
$$ language 'plpgsql';

-- Function to add credits
CREATE OR REPLACE FUNCTION add_credits(
    p_tenant_id UUID,
    p_amount INTEGER,
    p_description TEXT,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS VOID AS $$
DECLARE
    v_new_balance INTEGER;
BEGIN
    -- Insert or update balance
    INSERT INTO credit_balances (tenant_id, balance, lifetime_credits)
    VALUES (p_tenant_id, p_amount, p_amount)
    ON CONFLICT (tenant_id)
    DO UPDATE SET
        balance = credit_balances.balance + p_amount,
        lifetime_credits = credit_balances.lifetime_credits + p_amount,
        last_recharge_at = NOW(),
        updated_at = NOW()
    RETURNING balance INTO v_new_balance;
    
    -- Log transaction
    INSERT INTO credit_transactions (tenant_id, type, amount, balance_after, description, metadata)
    VALUES (p_tenant_id, 'purchase', p_amount, v_new_balance, p_description, p_metadata);
END;
$$ language 'plpgsql';

-- Function to log usage
CREATE OR REPLACE FUNCTION log_usage(
    p_tenant_id UUID,
    p_service_type TEXT,
    p_credits_used INTEGER,
    p_metadata JSONB DEFAULT '{}'
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO usage_logs (tenant_id, service_type, credits_used, metadata)
    VALUES (p_tenant_id, p_service_type, p_credits_used, p_metadata);
END;
$$ language 'plpgsql';

-- ============================================
-- PART 8: SYSTEM CONFIGURATION (Super Admin)
-- ============================================

-- System-wide configuration table
CREATE TABLE IF NOT EXISTS system_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT UNIQUE NOT NULL,
    value JSONB NOT NULL,
    description TEXT,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE system_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY system_config_super_admin ON system_config FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

-- Insert default system configuration
INSERT INTO system_config (key, value, description) VALUES
('credit_costs', '{"sms": 1, "ai_message": 5, "appointment_booking": 3, "call": 1}', 'Credit costs per service type'),
('llm_providers', '{"groq": {"name": "Groq", "models": [{"id": "llama3-70b-8192", "name": "Llama 3 70B", "cost_per_1k_tokens": 0.00027}, {"id": "llama3-8b-8192", "name": "Llama 3 8B", "cost_per_1k_tokens": 0.0001}, {"id": "mixtral-8x7b-32768", "name": "Mixtral 8x7B", "cost_per_1k_tokens": 0.00027}]}, "openai": {"name": "OpenAI", "models": [{"id": "gpt-4", "name": "GPT-4", "cost_per_1k_tokens": 0.03}, {"id": "gpt-4-turbo-preview", "name": "GPT-4 Turbo", "cost_per_1k_tokens": 0.01}, {"id": "gpt-3.5-turbo", "name": "GPT-3.5 Turbo", "cost_per_1k_tokens": 0.0005}]}, "anthropic": {"name": "Anthropic", "models": [{"id": "claude-3-opus-20240229", "name": "Claude 3 Opus", "cost_per_1k_tokens": 0.015}, {"id": "claude-3-sonnet-20240229", "name": "Claude 3 Sonnet", "cost_per_1k_tokens": 0.003}, {"id": "claude-3-haiku-20240307", "name": "Claude 3 Haiku", "cost_per_1k_tokens": 0.00025}]}}', 'Available LLM providers and models with pricing'),
('branding', '{"app_name": "Missed Call Responder", "logo_url": "", "favicon_url": "", "primary_color": "#3B82F6", "secondary_color": "#10B981", "footer_text": "© 2024 Missed Call Responder. All rights reserved.", "support_email": "support@missedcallresponder.com", "support_phone": ""}', 'Application branding and customization'),
('notifications', '{"from_name": "Missed Call Responder", "from_email": "notifications@missedcallresponder.com", "welcome_subject": "Welcome to Missed Call Responder", "low_credit_threshold": 100, "low_credit_subject": "Low Credit Balance Alert"}', 'Notification templates and settings'),
('billing', '{"currency": "USD", "trial_days": 14, "grace_period_days": 3, "auto_suspend_days": 7, "invoice_prefix": "MCR-"}', 'Billing configuration'),
('features', '{"enable_byok": true, "enable_credits": true, "enable_ai": true, "enable_appointments": true, "enable_suitedash": true, "enable_white_label": true}', 'Feature flags'),
('metadata', '{"custom_fields": {}, "tags": [], "notes": "", "integrations": {}}', 'Custom metadata for super admin use'),
('mintbird_integration', '{"enabled": false, "webhook_secret": "", "product_mapping": {}, "auto_provision": true}', 'MintBird purchase integration settings'),
('smtp_settings', '{"host": "", "port": 587, "username": "", "password_encrypted": "", "from_email": "", "from_name": "", "use_tls": true}', 'Custom SMTP configuration for emails'),
('email_templates', '{
  "default_welcome": {
    "subject": "Welcome to {{app_name}}!",
    "format": "plain",
    "body": "Hi {{first_name}},\n\nWelcome to {{app_name}}! Your account has been created.\n\nLogin Details:\n- Email: {{email}}\n- Temporary Password: {{temp_password}}\n- Dashboard: https://missedcallresponder.netlify.com/login\n\nPlease change your password after your first login.\n\nBest regards,\n{{app_name}} Team",
    "body_html": "<html><body><h2>Welcome to {{app_name}}!</h2><p>Hi {{first_name}},</p><p>Your account has been created.</p><h3>Login Details:</h3><ul><li>Email: {{email}}</li><li>Temporary Password: {{temp_password}}</li><li><a href=\"https://missedcallresponder.netlify.com/login\">Dashboard</a></li></ul><p>Please change your password after your first login.</p><p>Best regards,<br>{{app_name}} Team</p></body></html>"
  },
  "mintbird_welcome": {
    "subject": "Welcome to {{app_name}} - Your {{plan_name}} Plan is Active!",
    "format": "plain",
    "body": "Hi {{first_name}},\n\nThank you for purchasing the {{plan_name}} plan!\n\nYour account has been created and is ready to use.\n\nLogin Details:\n- Email: {{email}}\n- Temporary Password: {{temp_password}}\n- Dashboard: https://missedcallresponder.netlify.com/login\n\nOrder ID: {{order_id}}\n\nPlease change your password after your first login.\n\nBest regards,\n{{app_name}} Team",
    "body_html": "<html><body><h2>Welcome to {{app_name}}!</h2><p>Hi {{first_name}},</p><p>Thank you for purchasing the <strong>{{plan_name}}</strong> plan!</p><h3>Login Details:</h3><ul><li>Email: {{email}}</li><li>Temporary Password: {{temp_password}}</li><li><a href=\"https://missedcallresponder.netlify.com/login\">Dashboard</a></li></ul><p>Order ID: {{order_id}}</p><p>Best regards,<br>{{app_name}} Team</p></body></html>"
  },
  "low_credits": {
    "subject": "Low Credit Balance Alert - {{app_name}}",
    "format": "plain",
    "body": "Hi {{first_name}},\n\nThis is a friendly reminder that your credit balance is running low.\n\nCurrent Balance: {{credits}} credits\n\nTo avoid service interruption, please add more credits to your account.\n\nLogin to your dashboard: https://missedcallresponder.netlify.com/login\n\nBest regards,\n{{app_name}} Team",
    "body_html": "<html><body><h2>Low Credit Balance Alert</h2><p>Hi {{first_name}},</p><p>This is a friendly reminder that your credit balance is running low.</p><div style=\"background: #fef3c7; padding: 15px; border-radius: 5px; margin: 20px 0;\"><strong>Current Balance: {{credits}} credits</strong></div><p>To avoid service interruption, please <a href=\"https://missedcallresponder.netlify.com/login\">add more credits</a> to your account.</p><p>Best regards,<br>{{app_name}} Team</p></body></html>"
  },
  "missed_call_alert": {
    "subject": "New Missed Call from {{phone_number}}",
    "format": "plain",
    "body": "Hi {{first_name}},\n\nYou have a new missed call:\n\nPhone: {{phone_number}}\nTime: {{timestamp}}\n\nOur AI has automatically sent a follow-up SMS to the caller.\n\nView details: https://missedcallresponder.netlify.com/login\n\nBest regards,\n{{app_name}} Team",
    "body_html": "<html><body><h2>New Missed Call</h2><p>Hi {{first_name}},</p><p>You have a new missed call:</p><div style=\"background: #f3f4f6; padding: 15px; border-radius: 5px; margin: 20px 0;\"><strong>Phone:</strong> {{phone_number}}<br><strong>Time:</strong> {{timestamp}}</div><p>Our AI has automatically sent a follow-up SMS to the caller.</p><p><a href=\"https://missedcallresponder.netlify.com/login\" style=\"background: #3B82F6; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;\">View Details</a></p><p>Best regards,<br>{{app_name}} Team</p></body></html>"
  }
}', 'Editable email templates with HTML/plain text toggle and variable substitution');

-- ============================================
-- PART 9: SUPER ADMIN METADATA TABLE
-- ============================================

-- Flexible metadata storage for any entity
CREATE TABLE IF NOT EXISTS super_admin_metadata (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL, -- 'tenant', 'user', 'plan', 'system', etc.
    entity_id UUID,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    description TEXT,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(entity_type, entity_id, key)
);

-- Enable RLS
ALTER TABLE super_admin_metadata ENABLE ROW LEVEL SECURITY;

CREATE POLICY super_admin_metadata_policy ON super_admin_metadata FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

-- Create index for fast lookups
CREATE INDEX idx_super_admin_metadata_lookup ON super_admin_metadata(entity_type, entity_id, key);

-- ============================================
-- PART 10: DEFAULT DATA
-- ============================================

-- Create default LLM settings for existing tenants
INSERT INTO tenant_llm_settings (tenant_id, use_own_key, provider, model)
SELECT id, FALSE, 'groq', 'llama3-70b-8192'
FROM tenants
ON CONFLICT DO NOTHING;

-- Create default credit balances
INSERT INTO credit_balances (tenant_id, balance)
SELECT id, 100
FROM tenants
ON CONFLICT DO NOTHING;

-- Create default notification settings
INSERT INTO notification_settings (tenant_id)
SELECT id FROM tenants
ON CONFLICT DO NOTHING;

-- ============================================
-- ✅ MIGRATION COMPLETE
-- ============================================
