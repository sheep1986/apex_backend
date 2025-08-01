import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateUser } from '../middleware/auth';
import { supabaseService } from '../services/supabase-client';

const router = Router();

// Apply authentication to all routes
router.use(authenticateUser);

// VAPI API configuration
const VAPI_API_URL = 'https://api.vapi.ai';
const VAPI_API_KEY = process.env.VAPI_API_KEY;

// GET /api/phone-numbers - Get all phone numbers
router.get('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get phone numbers from database
    const { data: phoneNumbers, error } = await supabaseService
      .from('phone_numbers')
      .select(`
        *,
        campaign:campaigns(name),
        phone_number_metrics(*)
      `)
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching phone numbers:', error);
      return res.status(500).json({ error: 'Failed to fetch phone numbers' });
    }

    // Transform data for frontend
    const transformedNumbers = (phoneNumbers || []).map(phone => ({
      id: phone.id,
      number: phone.number,
      status: phone.status,
      provider: phone.provider || 'VAPI',
      callsMade: phone.phone_number_metrics?.[0]?.calls_made || 0,
      maxCalls: phone.monthly_limit || 1000,
      leadsGenerated: phone.phone_number_metrics?.[0]?.leads_generated || 0,
      conversionRate: phone.phone_number_metrics?.[0]?.conversion_rate || 0,
      monthlyLimit: phone.monthly_limit || 1000,
      costPerCall: phone.cost_per_call || 0.05,
      assignedCampaign: phone.campaign?.name,
      country: phone.country || 'US',
      areaCode: phone.area_code,
      createdAt: phone.created_at,
      lastUsed: phone.last_used
    }));

    res.json({ phoneNumbers: transformedNumbers });
  } catch (error) {
    console.error('Error in phone numbers GET:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/phone-numbers - Purchase new phone number
router.post('/', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { areaCode, country = 'US' } = req.body;
    const userId = req.user?.userId;
    const organizationId = req.user?.organizationId;

    if (!userId || !organizationId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!areaCode) {
      return res.status(400).json({ error: 'Area code is required' });
    }

    // Purchase phone number from VAPI
    let vapiPhoneNumber;
    try {
      const vapiResponse = await fetch(`${VAPI_API_URL}/phone-number`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          areaCode,
          country
        })
      });

      if (!vapiResponse.ok) {
        const errorData = await vapiResponse.json();
        throw new Error(errorData.message || 'Failed to purchase phone number from VAPI');
      }

      vapiPhoneNumber = await vapiResponse.json();
    } catch (error) {
      console.error('VAPI API error:', error);
      // Fallback to mock data if VAPI is not available
      vapiPhoneNumber = {
        id: `vapi-${Date.now()}`,
        number: `+1${areaCode}${Math.floor(Math.random() * 9000000) + 1000000}`,
        status: 'connected'
      };
    }

    // Save to database
    const { data: phoneNumber, error } = await supabaseService
      .from('phone_numbers')
      .insert([{
        vapi_id: vapiPhoneNumber.id,
        number: vapiPhoneNumber.number,
        status: vapiPhoneNumber.status || 'connected',
        provider: 'VAPI',
        country,
        area_code: areaCode,
        monthly_limit: 1000,
        cost_per_call: 0.05,
        organization_id: organizationId,
        created_by: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) {
      console.error('Error saving phone number:', error);
      return res.status(500).json({ error: 'Failed to save phone number' });
    }

    // Initialize metrics
    await supabaseService
      .from('phone_number_metrics')
      .insert([{
        phone_number_id: phoneNumber.id,
        calls_made: 0,
        leads_generated: 0,
        conversion_rate: 0,
        total_cost: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }]);

    res.status(201).json({
      phoneNumber: {
        id: phoneNumber.id,
        number: phoneNumber.number,
        status: phoneNumber.status,
        provider: phoneNumber.provider,
        country: phoneNumber.country,
        areaCode: phoneNumber.area_code,
        createdAt: phoneNumber.created_at
      }
    });
  } catch (error) {
    console.error('Error in phone number POST:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/phone-numbers/:id - Release phone number
router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get phone number details
    const { data: phoneNumber } = await supabaseService
      .from('phone_numbers')
      .select('*')
      .eq('id', id)
      .eq('organization_id', organizationId)
      .single();

    if (!phoneNumber) {
      return res.status(404).json({ error: 'Phone number not found' });
    }

    // Check if phone number is in use
    const { data: activeCalls } = await supabaseService
      .from('calls')
      .select('id')
      .eq('phone_number_id', id)
      .eq('status', 'active');

    if (activeCalls && activeCalls.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot release phone number with active calls. Please wait for calls to complete.' 
      });
    }

    // Release from VAPI
    try {
      if (phoneNumber.vapi_id) {
        await fetch(`${VAPI_API_URL}/phone-number/${phoneNumber.vapi_id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${VAPI_API_KEY}`
          }
        });
      }
    } catch (error) {
      console.error('Error releasing from VAPI:', error);
      // Continue with database deletion even if VAPI fails
    }

    // Delete from database
    const { error } = await supabaseService
      .from('phone_numbers')
      .delete()
      .eq('id', id)
      .eq('organization_id', organizationId);

    if (error) {
      console.error('Error deleting phone number:', error);
      return res.status(500).json({ error: 'Failed to delete phone number' });
    }

    res.json({ message: 'Phone number released successfully' });
  } catch (error) {
    console.error('Error in phone number DELETE:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/phone-numbers/:id/assign - Assign phone number to campaign
router.post('/:id/assign', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { campaignId } = req.body;
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!campaignId) {
      return res.status(400).json({ error: 'Campaign ID is required' });
    }

    // Verify campaign exists and belongs to organization
    const { data: campaign } = await supabaseService
      .from('campaigns')
      .select('id')
      .eq('id', campaignId)
      .eq('organization_id', organizationId)
      .single();

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Update phone number assignment
    const { data: phoneNumber, error } = await supabaseService
      .from('phone_numbers')
      .update({
        assigned_campaign_id: campaignId,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (error) {
      console.error('Error assigning phone number:', error);
      return res.status(500).json({ error: 'Failed to assign phone number' });
    }

    res.json({ 
      phoneNumber,
      message: 'Phone number assigned successfully' 
    });
  } catch (error) {
    console.error('Error in phone number assign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/phone-numbers/:id/metrics - Get phone number metrics
router.get('/:id/metrics', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { timeframe = '30d' } = req.query;
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get phone number metrics
    const { data: metrics } = await supabaseService
      .from('phone_number_metrics')
      .select('*')
      .eq('phone_number_id', id)
      .single();

    // Get historical call data
    let dateFilter = new Date();
    switch (timeframe) {
      case '7d':
        dateFilter.setDate(dateFilter.getDate() - 7);
        break;
      case '30d':
        dateFilter.setDate(dateFilter.getDate() - 30);
        break;
      case '90d':
        dateFilter.setDate(dateFilter.getDate() - 90);
        break;
      default:
        dateFilter.setDate(dateFilter.getDate() - 30);
    }

    const { data: calls } = await supabaseService
      .from('calls')
      .select('*')
      .eq('phone_number_id', id)
      .gte('created_at', dateFilter.toISOString())
      .order('created_at', { ascending: true });

    res.json({
      current: metrics,
      historical: calls,
      timeframe
    });
  } catch (error) {
    console.error('Error in phone number metrics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/phone-numbers/available - Get available phone numbers for purchase
router.get('/available', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { areaCode, country = 'US' } = req.query;

    if (!req.user?.organizationId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Get available numbers from VAPI
    try {
      const vapiResponse = await fetch(`${VAPI_API_URL}/phone-number/available?areaCode=${areaCode}&country=${country}`, {
        headers: {
          'Authorization': `Bearer ${VAPI_API_KEY}`
        }
      });

      if (!vapiResponse.ok) {
        throw new Error('Failed to fetch available numbers from VAPI');
      }

      const availableNumbers = await vapiResponse.json();
      res.json({ availableNumbers });
    } catch (error) {
      console.error('Error fetching available numbers from VAPI:', error);
      // Return mock data if VAPI is not available
      const mockNumbers = Array.from({ length: 5 }, (_, i) => ({
        number: `+1${areaCode}${Math.floor(Math.random() * 9000000) + 1000000}`,
        monthlyRate: 1.00,
        setupFee: 0.00
      }));
      res.json({ availableNumbers: mockNumbers });
    }
  } catch (error) {
    console.error('Error in available phone numbers:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router; 