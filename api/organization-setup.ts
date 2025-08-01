import { Router, Request, Response } from 'express';
import supabase from '../services/supabase-client';
import { v4 as uuidv4 } from 'uuid';
import { createClerkClient } from '@clerk/backend';
import { authenticateUser } from '../middleware/auth';
import { verifyToken } from '@clerk/backend';
import nodemailer from 'nodemailer';

const router = Router();

// Initialize Clerk client
const clerkClient = createClerkClient({ 
  secretKey: process.env.CLERK_SECRET_KEY 
});

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

interface CreateOrganizationRequest {
  name: string;
  slug?: string;
  type?: 'platform' | 'client';
  ownerEmail: string;
  ownerFirstName: string;
  ownerLastName: string;
  ownerRole?: string;
}

interface OrganizationSetupData {
  // Step 1: Organization Details
  businessName: string;
  email: string;
  country: string;
  website?: string;
  industry?: string;
  
  // Step 2: Admin User
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
  adminPhone?: string;
  useBusinessEmail: boolean; // Whether to use business email for admin
  
  // Step 3: Team Setup
  teamSize: '0-5' | '6-9' | '10+';
  addTeamMembers: boolean;
  teamMembers: Array<{
    firstName: string;
    lastName: string;
    email: string;
    role: 'admin' | 'user' | 'viewer';
  }>;
  
  // Step 4: VAPI Setup
  vapiApiKey: string;
  vapiPrivateKey: string;
}

// Special authentication for organization setup (doesn't require user to exist in database)
const authenticateSetupUser = async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No authentication token provided' });
    }

    const token = authHeader.substring(7);
    const hasClerkKey = !!process.env.CLERK_SECRET_KEY;
    
    // Verify Clerk token if available
    if (hasClerkKey) {
  try {
        const payload = await verifyToken(token, {
          secretKey: process.env.CLERK_SECRET_KEY,
        });

        if (payload && payload.sub) {
          // Just verify the token is valid, don't check if user exists in database
          // This endpoint will create the user
          req.clerkUser = {
            id: payload.sub,
            email: payload.email,
            firstName: payload.given_name,
            lastName: payload.family_name
          };
          return next();
        }
      } catch (clerkError) {
        console.error('Clerk verification failed:', clerkError);
        return res.status(401).json({ error: 'Invalid authentication token' });
      }
    }

    // In development mode, provide mock authentication
    if (process.env.NODE_ENV === 'development' && !hasClerkKey) {
      req.clerkUser = {
        id: 'dev-clerk-id',
        email: 'dev@apex.ai',
        firstName: 'Dev',
        lastName: 'User'
      };
      return next();
    }

    return res.status(401).json({ error: 'Authentication failed' });

  } catch (error) {
    console.error('Setup authentication error:', error);
    return res.status(401).json({ error: 'Authentication failed' });
  }
};

// POST /api/organization-setup/setup
router.post('/setup', authenticateSetupUser, async (req: Request, res: Response) => {
  try {
    const setupData: OrganizationSetupData = req.body;

    console.log('🚀 Starting organization setup process:', {
      businessName: setupData.businessName,
      adminEmail: setupData.adminEmail,
      teamSize: setupData.teamSize,
      hasVapiKeys: !!(setupData.vapiApiKey && setupData.vapiPrivateKey)
    });

    // Validate required fields
    if (!setupData.businessName || !setupData.adminEmail || !setupData.adminFirstName || !setupData.adminLastName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['businessName', 'adminEmail', 'adminFirstName', 'adminLastName']
      });
    }

    // Generate organization slug
    const organizationSlug = setupData.businessName.toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    // 1. Create organization with VAPI credentials
    console.log('🏢 Creating organization...');
    
    const organizationData: any = {
      name: setupData.businessName,
      slug: organizationSlug,
      type: 'client', // Use 'client' as per database constraint
      status: 'active',
      plan: 'professional',
      monthly_cost: 599.00,
      primary_color: '#3B82F6',
      secondary_color: '#1e40af',
      call_limit: 1000,
      user_limit: 10,
      storage_limit_gb: 10,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // Add VAPI credentials if provided (once columns are available)
    if (setupData.vapiApiKey && setupData.vapiPrivateKey) {
      organizationData.vapi_api_key = setupData.vapiApiKey; // In production, encrypt this
      organizationData.vapi_settings = JSON.stringify({
        privateKey: setupData.vapiPrivateKey, // In production, encrypt this
        configured_at: new Date().toISOString(),
        lastTested: null
      });
    }

    const { data: organization, error: orgError } = await supabase
      .from('organizations')
      .insert(organizationData)
      .select()
      .single();

    if (orgError) {
      console.error('❌ Error creating organization:', orgError);
      return res.status(500).json({
        success: false,
        error: 'Failed to create organization',
        details: orgError.message
      });
    }

    console.log('✅ Organization created:', organization.id);

    // 2. Create admin user
    console.log('👤 Creating admin user...');
    const { data: adminUser, error: userError } = await supabase
      .from('users')
      .insert({
        organization_id: organization.id,
        email: setupData.adminEmail,
        first_name: setupData.adminFirstName,
        last_name: setupData.adminLastName,
        role: 'client_admin', // SaaS admin role
        clerk_id: (req as any).clerkUser?.id || null, // Store Clerk ID for future authentication
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (userError) {
      console.error('❌ Error creating admin user:', userError);
      
      // Cleanup: delete organization if user creation failed
      await supabase.from('organizations').delete().eq('id', organization.id);

      return res.status(500).json({
        success: false,
        error: 'Failed to create admin user',
        details: userError.message
      });
    }

    console.log('✅ Admin user created:', adminUser.id);

    // 3. Create team members if specified
    let teamMembersCreated = 0;
    if (setupData.addTeamMembers && setupData.teamMembers?.length > 0) {
      console.log('👥 Creating team members...');
      
      for (const member of setupData.teamMembers) {
        try {
          const { data: teamMember, error: memberError } = await supabase
            .from('users')
      .insert({
        organization_id: organization.id,
              email: member.email,
              first_name: member.firstName,
              last_name: member.lastName,
              role: `client_${member.role}`,
              status: 'active',
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString()
      })
      .select()
      .single();

          if (memberError) {
            console.error(`⚠️ Warning: Could not create team member ${member.email}:`, memberError);
    } else {
            console.log(`✅ Team member created: ${member.email}`);
            teamMembersCreated++;
          }
        } catch (error) {
          console.error(`❌ Error creating team member ${member.email}:`, error);
        }
      }
    }

    // 4. Test and validate VAPI integration if credentials provided
    let vapiStatus: any = 'not_configured';
    if (setupData.vapiApiKey && setupData.vapiPrivateKey) {
      console.log('🔑 Testing VAPI integration...');
      
      try {
        // Test VAPI integration first
        const vapiTest = await testVapiIntegration(setupData.vapiApiKey, setupData.vapiPrivateKey);
        
        if (vapiTest.connected) {
          console.log('✅ VAPI credentials validated successfully');
          
          // Try to update organization with additional VAPI details if test succeeds
          // This will fail gracefully if the VAPI columns don't exist yet
          try {
            const { error: updateError } = await supabase
              .from('organizations')
              .update({
                vapi_settings: JSON.stringify({
                  privateKey: setupData.vapiPrivateKey,
                  configured_at: new Date().toISOString(),
                  lastTested: new Date().toISOString(),
                  testResults: {
                    connected: true,
                    assistantCount: vapiTest.assistantCount || 0,
                    lastTestedAt: new Date().toISOString()
                  }
                }),
                updated_at: new Date().toISOString()
              })
              .eq('id', organization.id);

            if (updateError) {
              console.log('⚠️ Could not update organization with VAPI test results (VAPI columns may not exist yet)');
              
              // Fallback: Store in organization_settings table for backward compatibility
              await supabase
                .from('organization_settings')
                .insert({
        organization_id: organization.id,
                  setting_key: 'vapi_credentials',
                  setting_value: JSON.stringify({
                    apiKey: setupData.vapiApiKey,
                    privateKey: setupData.vapiPrivateKey,
                    configured_at: new Date().toISOString(),
                    testResults: vapiTest
                  }),
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                });
                
              console.log('✅ VAPI credentials stored in organization_settings (fallback)');
            } else {
              console.log('✅ VAPI credentials stored in organizations table');
            }
          } catch (fallbackError) {
            console.log('⚠️ Warning: Could not store VAPI credentials:', fallbackError);
          }
          
          vapiStatus = {
            status: 'ready',
            connected: true,
            message: vapiTest.message,
            assistantCount: vapiTest.assistantCount || 0
          };
        } else {
          console.log('⚠️ VAPI integration test failed');
          vapiStatus = {
            status: 'error',
            connected: false,
            message: vapiTest.message
          };
        }
      } catch (error) {
        console.error('❌ Error testing VAPI integration:', error);
        vapiStatus = {
          status: 'error',
          connected: false,
          message: 'Failed to test VAPI integration'
        };
      }
    }

    // 5. Return success response
    console.log('🎉 Organization setup completed successfully!');
    
    res.status(201).json({
      success: true,
      message: `Organization "${setupData.businessName}" created successfully`,
      organizationId: organization.id,
      organizationName: organization.name,
      adminEmail: setupData.adminEmail,
      teamMembersCreated,
      vapiStatus,
      nextSteps: {
        loginUrl: `${process.env.FRONTEND_URL}/login`,
        dashboardUrl: `${process.env.FRONTEND_URL}/dashboard`,
        setupGuide: `${process.env.FRONTEND_URL}/onboarding`
      }
    });

  } catch (error) {
    console.error('💥 Unexpected error in organization setup:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during organization setup',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/organization-setup/test
router.get('/test', async (req: Request, res: Response) => {
  try {
    // Test database connectivity
    const { data: orgs, error: orgsError } = await supabase
      .from('organizations')
      .select('id, name, type, status')
      .limit(5);

    const { data: users, error: usersError } = await supabase
      .from('users')
      .select('id, email, role, organization_id')
      .limit(5);

    res.json({
      success: true,
      database: {
        organizations: {
          count: orgs?.length || 0,
          error: orgsError?.message || null,
          sample: orgs?.[0] || null
        },
        users: {
          count: users?.length || 0,
          error: usersError?.message || null,
          sample: users?.[0] || null
        }
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/organization-setup/organizations
router.get('/organizations', async (req: Request, res: Response) => {
  try {
    const { data: organizations, error } = await supabase
      .from('organizations')
      .select(`
        id,
        name,
        slug,
        type,
        status,
        plan,
        created_at,
        users!organization_id (
          id,
          email,
          first_name,
          last_name,
          role,
          status
        )
      `)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({
        error: 'Failed to fetch organizations',
        details: error.message
      });
    }

    res.json({
      success: true,
      organizations: organizations || []
    });

  } catch (error) {
    res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Verify email endpoint
router.post('/verify-email', async (req, res) => {
  try {
    const { token } = req.body;

    // Find verification record
    const { data: verification, error: verificationError } = await supabase
      .from('email_verifications')
      .select('*')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (verificationError || !verification) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired verification token'
      });
    }

    // Update organization status to active
    await supabase
      .from('organizations')
      .update({ 
        status: 'active',
        email_verified_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', verification.organization_id);

    // Mark verification as used
    await supabase
      .from('email_verifications')
      .update({ verified_at: new Date().toISOString() })
      .eq('id', verification.id);

    console.log('✅ Email verified for organization:', verification.organization_id);

    res.json({
      success: true,
      message: 'Email verified successfully! Your organization is now active.'
    });

  } catch (error) {
    console.error('❌ Email verification failed:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify email'
    });
  }
});

// Helper functions
function generateTemporaryPassword(): string {
  return Math.random().toString(36).slice(-12) + Math.random().toString(36).slice(-12);
}

function generateVerificationToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

async function testVapiIntegration(apiKey: string, privateKey: string) {
  try {
    console.log('🧪 Testing VAPI integration...');
    
    // Make a test call to VAPI API to verify credentials
    const response = await fetch('https://api.vapi.ai/assistants', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      const assistants = await response.json();
      console.log('✅ VAPI integration test successful:', assistants?.length || 0, 'assistants found');
      
    return {
      connected: true,
      status: 'ready',
        message: `VAPI integration configured successfully. Found ${assistants?.length || 0} assistants.`,
        assistantCount: assistants?.length || 0
      };
    } else {
      const errorData = await response.json().catch(() => ({}));
      console.error('❌ VAPI integration test failed:', response.status, errorData);
      
      return {
        connected: false,
        status: 'error',
        message: `VAPI API test failed: ${response.status} ${errorData.message || response.statusText}`
    };
    }
  } catch (error) {
    console.error('❌ VAPI integration test error:', error);
    return {
      connected: false,
      status: 'error',
      message: 'VAPI integration failed: ' + (error instanceof Error ? error.message : 'Unknown error')
    };
  }
}

async function sendVerificationEmail({ email, firstName, organizationName, verificationToken, clerkUserId }) {
  const verificationUrl = `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`;
  
  const mailOptions = {
    from: process.env.SMTP_EMAIL,
    to: email,
    subject: `Welcome to Apex AI - Verify Your Organization`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #059669;">Welcome to Apex AI Calling Platform!</h2>
        
        <p>Hi ${firstName},</p>
        
        <p>Congratulations! Your organization "<strong>${organizationName}</strong>" has been successfully created on the Apex AI Calling Platform.</p>
        
        <p>To activate your account and start using the platform, please verify your email address by clicking the button below:</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verificationUrl}" 
             style="background-color: #059669; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
            Verify Email & Activate Account
          </a>
        </div>
        
        <p><strong>What's Next?</strong></p>
        <ul>
          <li>✅ Verify your email address</li>
          <li>🔑 Complete your account setup</li>
          <li>🚀 Start creating AI calling campaigns</li>
          <li>📞 Launch your first VAPI-powered calls</li>
        </ul>
        
        <p>If you have any questions, please don't hesitate to contact our support team.</p>
        
        <p>Best regards,<br>The Apex AI Team</p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
        <p style="font-size: 12px; color: #6b7280;">
          This verification link will expire in 24 hours. If you didn't create this account, please ignore this email.
        </p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}

async function sendWelcomeEmail({ email, firstName, organizationName, isAdmin, clerkUserId }) {
  const setupUrl = `${process.env.FRONTEND_URL}/complete-setup?userId=${clerkUserId}`;
  
  const mailOptions = {
    from: process.env.SMTP_EMAIL,
    to: email,
    subject: `You've been invited to ${organizationName} on Apex AI`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #059669;">Welcome to ${organizationName}!</h2>
        
        <p>Hi ${firstName},</p>
        
        <p>You've been invited to join "<strong>${organizationName}</strong>" on the Apex AI Calling Platform.</p>
        
        <p>To complete your account setup and start collaborating with your team, please click the button below:</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${setupUrl}" 
             style="background-color: #059669; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold;">
            Complete Account Setup
          </a>
        </div>
        
        <p><strong>Your Role:</strong> ${isAdmin ? 'Administrator' : 'Team Member'}</p>
        
        <p><strong>What You Can Do:</strong></p>
        <ul>
          <li>🎯 Create and manage AI calling campaigns</li>
          <li>📊 View analytics and performance metrics</li>
          <li>👥 Collaborate with your team</li>
          <li>🔧 ${isAdmin ? 'Manage organization settings' : 'Access assigned projects'}</li>
        </ul>
        
        <p>If you have any questions, please contact your organization administrator or our support team.</p>
        
        <p>Best regards,<br>The Apex AI Team</p>
        
        <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
        <p style="font-size: 12px; color: #6b7280;">
          This invitation link will expire in 7 days. If you didn't expect this invitation, please contact the organization administrator.
        </p>
      </div>
    `
  };

  await transporter.sendMail(mailOptions);
}

export default router; 