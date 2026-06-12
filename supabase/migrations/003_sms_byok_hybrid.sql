-- ============================================
-- MIGRATION: SMS BYOK + Hybrid Phone Number Model
-- Run this in Supabase SQL Editor
-- ============================================

-- ============================================
-- PART 1: TENANT SMS SETTINGS (BYOK Support)
-- ============================================

CREATE TABLE IF NOT EXISTS tenant_sms_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    
    -- SMS Provider Settings
    use_own_telnyx_key BOOLEAN DEFAULT FALSE, -- BYOK: Use their own Telnyx account
    telnyx_api_key_encrypted TEXT, -- Encrypted API key for BYOK
    telnyx_phone_number TEXT, -- Their own phone number from Telnyx
    
    -- Fallback Settings (when BYOK fails)
    fallback_to_platform BOOLEAN DEFAULT TRUE, -- Use platform's Telnyx if theirs fails
    
    -- SMS Behavior
    auto_respond_missed_calls BOOLEAN DEFAULT TRUE,
    auto_respond_sms BOOLEAN DEFAULT TRUE,
    initial_sms_template TEXT DEFAULT 'Sorry we missed your call! We''re here now - reply CALL to schedule a callback or INFO for our services.',
    
    -- Cost Controls
    max_daily_sms INTEGER DEFAULT 100, -- Limit daily SMS to prevent runaway costs
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id)
);

-- Enable RLS
ALTER TABLE tenant_sms_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_sms_settings_isolation ON tenant_sms_settings FOR ALL USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
    OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_tenant_sms_settings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_tenant_sms_settings_updated_at
    BEFORE UPDATE ON tenant_sms_settings
    FOR EACH ROW EXECUTE FUNCTION update_tenant_sms_settings_updated_at();

-- ============================================
-- PART 2: PHONE NUMBER POOL (Platform-Managed)
-- ============================================

CREATE TABLE IF NOT EXISTS phone_number_pool (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Phone Number Details
    phone_number TEXT NOT NULL UNIQUE,
    area_code TEXT,
    region TEXT, -- e.g., "Florida", "California"
    
    -- Assignment Status
    tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ,
    
    -- Telnyx Details (Platform's Account)
    telnyx_number_id TEXT, -- Telnyx's internal ID for this number
    telnyx_messaging_profile_id TEXT,
    
    -- Status
    status TEXT DEFAULT 'available', -- 'available', 'assigned', 'reserved', 'suspended'
    
    -- Metadata
    monthly_cost DECIMAL(10,2) DEFAULT 1.00, -- Cost to platform
    notes TEXT,
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE phone_number_pool ENABLE ROW LEVEL SECURITY;

-- Super admin can manage all numbers
CREATE POLICY phone_number_pool_super_admin ON phone_number_pool FOR ALL USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role = 'super_admin')
);

-- Tenants can only see their assigned number
CREATE POLICY phone_number_pool_tenant ON phone_number_pool FOR SELECT USING (
    tenant_id IN (SELECT tenant_id FROM users WHERE id = auth.uid())
);

-- Indexes
CREATE INDEX idx_phone_number_pool_status ON phone_number_pool(status);
CREATE INDEX idx_phone_number_pool_tenant ON phone_number_pool(tenant_id);
CREATE INDEX idx_phone_number_pool_available ON phone_number_pool(status) WHERE status = 'available';

-- ============================================
-- PART 3: SUBSCRIPTION PLANS (Hybrid Model)
-- ============================================

-- Update existing subscription_plans table or create if not exists
DO $$
BEGIN
    -- Add sms_model column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'subscription_plans' AND column_name = 'sms_model'
    ) THEN
        ALTER TABLE subscription_plans ADD COLUMN sms_model TEXT DEFAULT 'platform';
    END IF;
    
    -- Add allows_byok column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'subscription_plans' AND column_name = 'allows_byok'
    ) THEN
        ALTER TABLE subscription_plans ADD COLUMN allows_byok BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Insert/update subscription plans for hybrid model
INSERT INTO subscription_plans (name, description, price_monthly, price_yearly, included_credits, max_leads, max_users, sms_model, allows_byok, features)
VALUES 
    ('Starter', 'Perfect for small businesses just getting started', 49, 490, 500, 100, 2, 'platform', FALSE, '["missed_call_responder", "basic_templates", "email_support"]'),
    ('Growth', 'For growing businesses with higher volume', 99, 990, 1500, 500, 5, 'platform', FALSE, '["missed_call_responder", "ai_conversations", "advanced_templates", "priority_support", "analytics"]'),
    ('Pro', 'For established businesses with BYOK option', 149, 1490, 3000, 2000, 10, 'hybrid', TRUE, '["missed_call_responder", "ai_conversations", "custom_templates", "byok_sms", "white_label", "dedicated_support", "advanced_analytics"]'),
    ('Enterprise', 'Full control with BYOK and custom integrations', 299, 2990, 10000, 10000, 50, 'byok', TRUE, '["missed_call_responder", "ai_conversations", "custom_templates", "byok_sms", "byok_llm", "white_label", "dedicated_support", "custom_integrations", "sla"]')
ON CONFLICT (name) DO UPDATE SET
    description = EXCLUDED.description,
    price_monthly = EXCLUDED.price_monthly,
    price_yearly = EXCLUDED.price_yearly,
    included_credits = EXCLUDED.included_credits,
    max_leads = EXCLUDED.max_leads,
    max_users = EXCLUDED.max_users,
    sms_model = EXCLUDED.sms_model,
    allows_byok = EXCLUDED.allows_byok,
    features = EXCLUDED.features;

-- ============================================
-- PART 4: FUNCTIONS FOR PHONE NUMBER MANAGEMENT
-- ============================================

-- Function to assign a phone number from pool to tenant
CREATE OR REPLACE FUNCTION assign_phone_number(
    p_tenant_id UUID,
    p_area_code TEXT DEFAULT NULL
)
RETURNS TABLE (phone_number TEXT, success BOOLEAN, message TEXT) AS $$
DECLARE
    v_number_id UUID;
    v_phone_number TEXT;
BEGIN
    -- Check if tenant already has a number
    IF EXISTS (
        SELECT 1 FROM phone_number_pool 
        WHERE tenant_id = p_tenant_id AND status = 'assigned'
    ) THEN
        RETURN QUERY SELECT 
            (SELECT phone_number FROM phone_number_pool WHERE tenant_id = p_tenant_id AND status = 'assigned' LIMIT 1),
            FALSE,
            'Tenant already has an assigned phone number';
        RETURN;
    END IF;
    
    -- Find available number (prefer matching area code)
    SELECT id, phone_number INTO v_number_id, v_phone_number
    FROM phone_number_pool
    WHERE status = 'available'
    AND (p_area_code IS NULL OR area_code = p_area_code)
    ORDER BY 
        CASE WHEN area_code = p_area_code THEN 0 ELSE 1 END,
        created_at
    LIMIT 1;
    
    IF v_number_id IS NULL THEN
        -- Try any available number if area code match not found
        SELECT id, phone_number INTO v_number_id, v_phone_number
        FROM phone_number_pool
        WHERE status = 'available'
        ORDER BY created_at
        LIMIT 1;
    END IF;
    
    IF v_number_id IS NULL THEN
        RETURN QUERY SELECT NULL::TEXT, FALSE, 'No available phone numbers in pool';
        RETURN;
    END IF;
    
    -- Assign the number
    UPDATE phone_number_pool
    SET 
        tenant_id = p_tenant_id,
        status = 'assigned',
        assigned_at = NOW()
    WHERE id = v_number_id;
    
    -- Update tenant record
    UPDATE tenants
    SET phone_number = v_phone_number,
        updated_at = NOW()
    WHERE id = p_tenant_id;
    
    RETURN QUERY SELECT v_phone_number, TRUE, 'Phone number assigned successfully';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to release a phone number back to pool
CREATE OR REPLACE FUNCTION release_phone_number(
    p_tenant_id UUID
)
RETURNS TABLE (phone_number TEXT, success BOOLEAN, message TEXT) AS $$
DECLARE
    v_phone_number TEXT;
BEGIN
    -- Get the assigned number
    SELECT phone_number INTO v_phone_number
    FROM phone_number_pool
    WHERE tenant_id = p_tenant_id AND status = 'assigned';
    
    IF v_phone_number IS NULL THEN
        RETURN QUERY SELECT NULL::TEXT, FALSE, 'No phone number assigned to this tenant';
        RETURN;
    END IF;
    
    -- Release the number
    UPDATE phone_number_pool
    SET 
        tenant_id = NULL,
        status = 'available',
        assigned_at = NULL,
        updated_at = NOW()
    WHERE tenant_id = p_tenant_id;
    
    -- Clear tenant phone number
    UPDATE tenants
    SET phone_number = NULL,
        updated_at = NOW()
    WHERE id = p_tenant_id;
    
    RETURN QUERY SELECT v_phone_number, TRUE, 'Phone number released successfully';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- PART 5: AUDIT LOGGING FOR PHONE NUMBERS
-- ============================================

-- Add phone number changes to audit log trigger
CREATE OR REPLACE FUNCTION log_phone_number_changes()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
            INSERT INTO audit_logs (user_id, tenant_id, action, entity_type, entity_id, old_data, new_data)
            VALUES (
                auth.uid(),
                COALESCE(NEW.tenant_id, OLD.tenant_id),
                CASE 
                    WHEN NEW.tenant_id IS NOT NULL THEN 'phone_number.assigned'
                    ELSE 'phone_number.released'
                END,
                'phone_number',
                NEW.id,
                jsonb_build_object('tenant_id', OLD.tenant_id, 'status', OLD.status),
                jsonb_build_object('tenant_id', NEW.tenant_id, 'status', NEW.status)
            );
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER phone_number_audit
    AFTER UPDATE ON phone_number_pool
    FOR EACH ROW EXECUTE FUNCTION log_phone_number_changes();

-- ============================================
-- PART 6: DEFAULT DATA
-- ============================================

-- Insert default SMS settings for existing tenants
INSERT INTO tenant_sms_settings (tenant_id, use_own_telnyx_key, fallback_to_platform)
SELECT id, FALSE, TRUE
FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- ============================================
-- MIGRATION COMPLETE
-- ============================================

COMMENT ON TABLE tenant_sms_settings IS 'Stores tenant SMS configuration including BYOK Telnyx settings';
COMMENT ON TABLE phone_number_pool IS 'Pool of phone numbers managed by the platform for assignment to tenants';
