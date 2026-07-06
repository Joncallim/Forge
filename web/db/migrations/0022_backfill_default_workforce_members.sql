WITH default_member_roles(slug, agent_type, role_label, preferred_sequence, metadata) AS (
  VALUES
    ('core-delivery', 'architect', 'Workforce supervisor', 1, '{"workforceSupervisor":true,"responsibility":"Manage workflow inside this workforce."}'::jsonb),
    ('core-delivery', 'product', NULL, 2, '{}'::jsonb),
    ('core-delivery', 'ux', NULL, 3, '{}'::jsonb),
    ('core-delivery', 'frontend', NULL, 4, '{}'::jsonb),
    ('core-delivery', 'backend', NULL, 5, '{}'::jsonb),
    ('core-delivery', 'qa', NULL, 6, '{}'::jsonb),
    ('core-delivery', 'reviewer', NULL, 7, '{}'::jsonb),
    ('core-delivery', 'security', NULL, 8, '{}'::jsonb),
    ('core-delivery', 'devops', NULL, 9, '{}'::jsonb),
    ('core-delivery', 'documentation', NULL, 10, '{}'::jsonb),
    ('product-discovery', 'architect', 'Workforce supervisor', 1, '{"workforceSupervisor":true,"responsibility":"Manage workflow inside this workforce."}'::jsonb),
    ('product-discovery', 'product', NULL, 2, '{}'::jsonb),
    ('product-discovery', 'ux', NULL, 3, '{}'::jsonb),
    ('product-discovery', 'documentation', NULL, 4, '{}'::jsonb),
    ('product-discovery', 'reviewer', NULL, 5, '{}'::jsonb),
    ('ux-ui-delivery', 'architect', 'Workforce supervisor', 1, '{"workforceSupervisor":true,"responsibility":"Manage workflow inside this workforce."}'::jsonb),
    ('ux-ui-delivery', 'product', NULL, 2, '{}'::jsonb),
    ('ux-ui-delivery', 'ux', NULL, 3, '{}'::jsonb),
    ('ux-ui-delivery', 'frontend', NULL, 4, '{}'::jsonb),
    ('ux-ui-delivery', 'qa', NULL, 5, '{}'::jsonb),
    ('ux-ui-delivery', 'reviewer', NULL, 6, '{}'::jsonb),
    ('backend-api-delivery', 'architect', 'Workforce supervisor', 1, '{"workforceSupervisor":true,"responsibility":"Manage workflow inside this workforce."}'::jsonb),
    ('backend-api-delivery', 'backend', NULL, 2, '{}'::jsonb),
    ('backend-api-delivery', 'qa', NULL, 3, '{}'::jsonb),
    ('backend-api-delivery', 'security', NULL, 4, '{}'::jsonb),
    ('backend-api-delivery', 'reviewer', NULL, 5, '{}'::jsonb),
    ('release-deployment', 'architect', 'Workforce supervisor', 1, '{"workforceSupervisor":true,"responsibility":"Manage workflow inside this workforce."}'::jsonb),
    ('release-deployment', 'devops', NULL, 2, '{}'::jsonb),
    ('release-deployment', 'qa', NULL, 3, '{}'::jsonb),
    ('release-deployment', 'security', NULL, 4, '{}'::jsonb),
    ('release-deployment', 'release', NULL, 5, '{}'::jsonb),
    ('release-deployment', 'documentation', NULL, 6, '{}'::jsonb),
    ('mcp-setup', 'architect', 'Workforce supervisor', 1, '{"workforceSupervisor":true,"responsibility":"Manage workflow inside this workforce."}'::jsonb),
    ('mcp-setup', 'mcp-installer', NULL, 2, '{}'::jsonb),
    ('mcp-setup', 'devops', NULL, 3, '{}'::jsonb),
    ('mcp-setup', 'security', NULL, 4, '{}'::jsonb),
    ('mcp-setup', 'documentation', NULL, 5, '{}'::jsonb)
),
eligible_members AS (
  SELECT
    workforces.id AS workforce_id,
    agent_configs.id AS agent_config_id,
    default_member_roles.role_label,
    default_member_roles.preferred_sequence,
    default_member_roles.metadata
  FROM default_member_roles
  INNER JOIN workforces ON workforces.slug = default_member_roles.slug
  INNER JOIN agent_configs ON agent_configs.agent_type = default_member_roles.agent_type
  WHERE NOT EXISTS (
    SELECT 1
    FROM workforce_agents
    WHERE workforce_agents.workforce_id = workforces.id
  )
),
ordered_members AS (
  SELECT
    workforce_id,
    agent_config_id,
    role_label,
    row_number() OVER (PARTITION BY workforce_id ORDER BY preferred_sequence)::integer AS sequence,
    metadata
  FROM eligible_members
)
INSERT INTO workforce_agents (
  workforce_id,
  agent_config_id,
  role_label,
  sequence,
  is_required,
  metadata,
  created_at,
  updated_at
)
SELECT
  workforce_id,
  agent_config_id,
  role_label,
  sequence,
  true,
  metadata,
  now(),
  now()
FROM ordered_members
ON CONFLICT (workforce_id, agent_config_id) DO NOTHING;
