import { VAPIIntegrationService } from './vapi-integration-service';
import { supabaseService } from './supabase-client';
import { MockWebhookService } from './mock-webhook-service';
import csv from 'csv-parser';
import { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';

// Interface definitions for VAPI outbound campaigns
export interface VAPIOutboundCampaign {
  id?: string;
  organizationId: string;
  name: string;
  description?: string;
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  
  // VAPI Configuration
  assistantId: string;
  phoneNumberId: string;
  
  // Campaign Settings
  leads: VAPILead[];
  schedule?: {
    startTime?: string;
    endTime?: string;
    timezone?: string;
    daysOfWeek?: number[];
    maxCallsPerDay?: number;
    callInterval?: number; // minutes between calls
  };
  
  // Call Settings
  maxRetries?: number;
  retryDelay?: number; // hours
  
  // Performance Tracking
  metrics: VAPICampaignMetrics;
}

export interface VAPILead {
  id?: string;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  company?: string;
  title?: string;
  customFields?: Record<string, any>;
  
  // Call tracking
  status: 'pending' | 'called' | 'connected' | 'no_answer' | 'voicemail' | 'busy' | 'failed' | 'completed' | 'do_not_call';
  callAttempts: number;
  lastCallAt?: string;
  nextCallAt?: string;
  
  // Results
  callDuration?: number;
  callOutcome?: string;
  transcript?: string;
  summary?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  cost?: number;
}

export interface VAPICampaignMetrics {
  totalLeads: number;
  callsAttempted: number;
  callsConnected: number;
  callsCompleted: number;
  connectionRate: number;
  completionRate: number;
  averageDuration: number;
  totalCost: number;
  positiveOutcomes: number;
  conversionRate: number;
  
  // Real-time stats
  activeCalls: number;
  callsToday: number;
  leadsRemaining: number;
  estimatedCompletion?: string;
}

export interface VAPICallResult {
  leadId: string;
  vapiCallId: string;
  status: 'pending' | 'queued' | 'ringing' | 'in-progress' | 'completed' | 'failed';
  startedAt?: string;
  endedAt?: string;
  duration?: number;
  cost?: number;
  transcript?: string;
  summary?: string;
  outcome?: string;
  sentiment?: string;
  recording?: string;
}

export class VAPIOutboundService {
  private vapiService: VAPIIntegrationService | null;
  private organizationId: string;

  constructor(organizationId: string, vapiService: VAPIIntegrationService | null) {
    this.organizationId = organizationId;
    this.vapiService = vapiService;
  }

  /**
   * Factory method to create VAPI outbound service for organization
   */
  static async forOrganization(organizationId: string): Promise<VAPIOutboundService | null> {
    try {
      const vapiService = await VAPIIntegrationService.forOrganization(organizationId);
      
      if (!vapiService) {
        console.log('⚠️ No VAPI credentials found for organization');
        return null;
      }

      return new VAPIOutboundService(organizationId, vapiService);
    } catch (error) {
      console.error('❌ Error creating VAPI outbound service:', error);
      return null;
    }
  }

  /**
   * Create a new VAPI outbound campaign
   */
  async createCampaign(campaignData: Partial<VAPIOutboundCampaign> & { 
    phoneNumber?: string; 
    csvData?: string;
    assignedTeam?: string[];
    sendTiming?: string;
    scheduleDate?: string;
    scheduleTime?: string;
    createdBy?: string;
  }): Promise<VAPIOutboundCampaign> {
    try {
      console.log('🚀 Creating VAPI outbound campaign:', campaignData.name);

      // Validate required fields
      if (!campaignData.name) {
        throw new Error('Campaign name is required');
      }

      // For real VAPI integration, validate assistant and phone data
      const hasVAPICredentials = this.vapiService !== null;
      const hasRealVAPIData = campaignData.assistantId && (campaignData.phoneNumberId || campaignData.phoneNumber);

      if (hasVAPICredentials && hasRealVAPIData) {
        console.log('✅ Using real VAPI integration');
        
        // Validate with VAPI API
        try {
          if (campaignData.assistantId && this.vapiService) {
            await this.vapiService.listAssistants(); // Test API connection
          }
        } catch (error) {
          console.warn('⚠️ VAPI API validation failed, proceeding with database-only campaign');
        }
      } else {
        console.log('📝 Creating development campaign (no VAPI credentials)');
      }

      // Prepare schedule data
      let schedule = campaignData.schedule;
      if (campaignData.sendTiming === 'schedule' && campaignData.scheduleDate && campaignData.scheduleTime) {
        schedule = {
          startTime: `${campaignData.scheduleDate}T${campaignData.scheduleTime}:00`,
          timezone: 'UTC',
          ...schedule
        };
      }

      // Create campaign in database
      const { data: campaign, error } = await supabaseService
        .from('campaigns')
        .insert([{
          organization_id: this.organizationId,
          name: campaignData.name,
          description: campaignData.description,
          type: 'outbound',
          status: campaignData.status || 'draft',
          assistant_id: campaignData.assistantId || 'dev-assistant-001',
          phone_number_id: campaignData.phoneNumberId || 'dev-phone-001', 
          created_by: campaignData.createdBy || '919004cd-19a8-4d10-a501-2bf59a581823', // Use valid UUID as fallback
          settings: {
            schedule,
            phoneNumber: campaignData.phoneNumber,
            assignedTeam: campaignData.assignedTeam || [],
            sendTiming: campaignData.sendTiming || 'now',
            maxRetries: campaignData.maxRetries || 3,
            retryDelay: campaignData.retryDelay || 24,
            hasVAPICredentials,
            realVAPIData: hasRealVAPIData,
            ...campaignData
          },
          total_calls: 0,
          successful_calls: 0,
          total_duration: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single();

      if (error) {
        throw new Error(`Failed to create campaign: ${error.message}`);
      }

      console.log('✅ Campaign created successfully:', campaign.id);

      // If CSV data is provided, process leads immediately
      if (campaignData.csvData) {
        try {
          const result = await this.uploadLeadsFromCSV(campaign.id, campaignData.csvData);
          console.log(`📤 Uploaded ${result.success} leads from CSV`);
        } catch (csvError) {
          console.warn('⚠️ Failed to process CSV data:', csvError);
        }
      }

      // Auto-start campaign if sendTiming is 'now' and we have VAPI credentials
      if (campaignData.sendTiming === 'now' && hasVAPICredentials && hasRealVAPIData) {
        try {
          console.log('🚀 Auto-starting campaign with sendTiming=now...');
          await this.startCampaign(campaign.id);
        } catch (startError) {
          console.warn('⚠️ Failed to auto-start campaign:', startError);
        }
      }

      // Initialize metrics
      const metrics: VAPICampaignMetrics = {
        totalLeads: 0,
        callsAttempted: 0,
        callsConnected: 0,
        callsCompleted: 0,
        connectionRate: 0,
        completionRate: 0,
        averageDuration: 0,
        totalCost: 0,
        positiveOutcomes: 0,
        conversionRate: 0,
        activeCalls: 0,
        callsToday: 0,
        leadsRemaining: 0
      };

      return {
        id: campaign.id,
        organizationId: this.organizationId,
        name: campaign.name,
        description: campaign.description,
        status: campaign.status,
        assistantId: campaign.assistant_id,
        phoneNumberId: campaign.phone_number_id,
        leads: [],
        schedule: campaign.settings?.schedule,
        maxRetries: campaign.settings?.maxRetries || 3,
        retryDelay: campaign.settings?.retryDelay || 24,
        metrics
      };

    } catch (error) {
      console.error('❌ Error creating VAPI campaign:', error);
      throw error;
    }
  }

  /**
   * Upload leads from CSV data to campaign
   */
  async uploadLeadsFromCSV(campaignId: string, csvData: string): Promise<{ success: number; failed: number; errors: string[] }> {
    try {
      console.log('📤 Uploading leads from CSV to campaign:', campaignId);

      const leads: Partial<VAPILead>[] = [];
      const errors: string[] = [];
      let lineNumber = 0;

      return new Promise((resolve, reject) => {
        const stream = Readable.from([csvData]);
        
        stream
          .pipe(csv())
          .on('data', (row) => {
            lineNumber++;
            try {
              // Handle flexible column names
              const phoneField = row.phone || row.number || row.telephone || row.phoneNumber || row.Phone || row.Number;
              const nameField = row.name || row.Name;
              const firstNameField = row.firstName || row.first_name || row.FirstName || row.firstname;
              const lastNameField = row.lastName || row.last_name || row.LastName || row.lastname;
              
              let firstName = firstNameField;
              let lastName = lastNameField;
              
              // If no firstName/lastName but has 'name' field, split it
              if (!firstName && !lastName && nameField) {
                const nameParts = nameField.trim().split(' ');
                firstName = nameParts[0];
                lastName = nameParts.slice(1).join(' ') || '';
              }
              
              // Validate required fields
              if (!firstName || !phoneField) {
                errors.push(`Line ${lineNumber}: Missing required fields (name and phone)`);
                return;
              }

              // Validate phone number format
              const phoneRegex = /^\+?[1-9]\d{1,14}$/;
              const cleanPhone = phoneField.replace(/[\s\-\(\)]/g, '');
              if (!phoneRegex.test(cleanPhone)) {
                errors.push(`Line ${lineNumber}: Invalid phone number format`);
                return;
              }

              // Create lead object
              const lead: Partial<VAPILead> = {
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                phone: this.formatPhoneNumber(cleanPhone),
                email: (row.email || row.Email)?.trim(),
                company: (row.company || row.Company)?.trim(),
                title: (row.title || row.Title || row.job_title || row.JobTitle)?.trim(),
                status: 'pending',
                callAttempts: 0,
                customFields: {}
              };

              // Add custom fields
              Object.keys(row).forEach(key => {
                const lowerKey = key.toLowerCase();
                if (!['firstname', 'lastname', 'phone', 'number', 'name', 'email', 'company', 'title', 'first_name', 'last_name', 'telephone', 'phonenumber', 'job_title'].includes(lowerKey)) {
                  lead.customFields![key] = row[key];
                }
              });

              leads.push(lead);
              console.log(`📝 Parsed lead ${lineNumber}: ${firstName} ${lastName} - ${cleanPhone}`);
            } catch (error) {
              errors.push(`Line ${lineNumber}: ${error.message}`);
            }
          })
          .on('end', async () => {
            try {
              console.log(`📊 Processing ${leads.length} leads for campaign ${campaignId}`);

              // Try to insert leads using upsert to handle duplicates gracefully
              const { data: insertedLeads, error: insertError } = await supabaseService
                .from('leads')
                .upsert(
                  leads.map(lead => ({
                    organization_id: this.organizationId,
                    campaign_id: campaignId,
                    first_name: lead.firstName,
                    last_name: lead.lastName,
                    phone: lead.phone,
                    email: lead.email,
                    company: lead.company,
                    job_title: lead.title,
                    status: 'pending', // Add the required status field
                    call_status: 'pending', // Add call_status field
                    call_attempts: 0,
                    custom_fields: lead.customFields || {},
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                  })),
                  { 
                    onConflict: 'organization_id,phone',
                    ignoreDuplicates: false // Update existing records
                  }
                )
                .select();

              if (insertError) {
                console.error('❌ Error inserting leads:', insertError);
                throw new Error(`Failed to insert leads: ${insertError.message}`);
              }

              // Update campaign metrics
              await this.updateCampaignMetrics(campaignId);

              console.log(`✅ Successfully uploaded ${insertedLeads?.length || 0} leads`);

              resolve({
                success: insertedLeads?.length || 0,
                failed: errors.length,
                errors
              });

            } catch (error) {
              reject(error);
            }
          })
          .on('error', (error) => {
            reject(error);
          });
      });

    } catch (error) {
      console.error('❌ Error uploading leads from CSV:', error);
      throw error;
    }
  }



  /**
   * Start a VAPI outbound campaign
   */
  async startCampaign(campaignId: string): Promise<void> {
    try {
      console.log('▶️ Starting VAPI campaign:', campaignId);

      // Get campaign details
      const { data: campaign, error: campaignError } = await supabaseService
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .eq('organization_id', this.organizationId)
        .single();

      if (campaignError || !campaign) {
        throw new Error('Campaign not found');
      }

      // Get pending leads for this campaign
      const { data: leads, error: leadsError } = await supabaseService
        .from('leads')
        .select('*')
        .eq('campaign_id', campaignId)
        .eq('call_status', 'pending')
        .order('created_at', { ascending: true });

      if (leadsError) {
        throw new Error(`Failed to fetch leads: ${leadsError.message}`);
      }

      // If no pending leads found, try to find any leads for this campaign
      if (!leads || leads.length === 0) {
        console.log('⚠️ No pending leads found, checking for any campaign leads...');
        
        const { data: allCampaignLeads, error: allLeadsError } = await supabaseService
          .from('leads')
          .select('*')
          .eq('campaign_id', campaignId)
          .order('created_at', { ascending: true });

        if (allLeadsError) {
          throw new Error(`Failed to fetch campaign leads: ${allLeadsError.message}`);
        }

        if (allCampaignLeads && allCampaignLeads.length > 0) {
          console.log(`📊 Found ${allCampaignLeads.length} total leads for campaign, but none are pending`);
          console.log('📊 Lead statuses:', allCampaignLeads.map(l => l.call_status));
          
          // Reset leads to pending if they're not in a final state
          const resetableStatuses = ['failed', 'no_answer', 'busy'];
          const leadsToReset = allCampaignLeads.filter(l => resetableStatuses.includes(l.call_status));
          
          if (leadsToReset.length > 0) {
            console.log(`🔄 Resetting ${leadsToReset.length} leads to pending status`);
            
            const { error: resetError } = await supabaseService
              .from('leads')
              .update({ call_status: 'pending', updated_at: new Date().toISOString() })
              .in('id', leadsToReset.map(l => l.id));

            if (resetError) {
              console.error('❌ Error resetting leads:', resetError);
            } else {
              // Re-fetch the pending leads
              const { data: resetLeads } = await supabaseService
                .from('leads')
                .select('*')
                .eq('campaign_id', campaignId)
                .eq('call_status', 'pending')
                .order('created_at', { ascending: true });

              if (resetLeads && resetLeads.length > 0) {
                console.log(`✅ Reset ${resetLeads.length} leads to pending status`);
                // Use the reset leads
                const finalLeads = resetLeads;
                
                // Update campaign status
                await supabaseService
                  .from('campaigns')
                  .update({
                    status: 'active',
                    updated_at: new Date().toISOString()
                  })
                  .eq('id', campaignId);

                console.log(`✅ Campaign started with ${finalLeads.length} leads`);

                // Start calling process
                this.processCampaignCalls(campaignId);
                return;
              }
            }
          }
        }
        
        // If still no leads, check if we can find leads by phone number and reassign them
        console.log('⚠️ No leads found for campaign, checking for existing leads in organization...');
        
        // This is a fallback - try to find any leads in the organization that aren't assigned to active campaigns
        const { data: orgLeads, error: orgLeadsError } = await supabaseService
          .from('leads')
          .select('*')
          .eq('organization_id', this.organizationId)
          .eq('call_status', 'pending')
          .is('campaign_id', null)
          .limit(10);

        if (orgLeadsError) {
          console.error('❌ Error fetching organization leads:', orgLeadsError);
        } else if (orgLeads && orgLeads.length > 0) {
          console.log(`📞 Found ${orgLeads.length} unassigned leads in organization, assigning to campaign`);
          
          // Assign these leads to the current campaign
          const { error: assignError } = await supabaseService
            .from('leads')
            .update({ 
              campaign_id: campaignId,
              updated_at: new Date().toISOString()
            })
            .in('id', orgLeads.map(l => l.id));

          if (assignError) {
            console.error('❌ Error assigning leads to campaign:', assignError);
          } else {
            console.log(`✅ Assigned ${orgLeads.length} leads to campaign`);
            
            // Update campaign status
            await supabaseService
              .from('campaigns')
              .update({
                status: 'active',
                updated_at: new Date().toISOString()
              })
              .eq('id', campaignId);

            console.log(`✅ Campaign started with ${orgLeads.length} assigned leads`);

            // Start calling process
            this.processCampaignCalls(campaignId);
            return;
          }
        } else {
          console.log('⚠️ No unassigned leads found, looking for leads from other campaigns to reassign...');
          
          // Last resort: Find leads in other campaigns that can be reassigned
          const { data: otherCampaignLeads, error: otherLeadsError } = await supabaseService
            .from('leads')
            .select('*')
            .eq('organization_id', this.organizationId)
            .in('call_status', ['pending', 'failed', 'no_answer', 'busy'])
            .not('campaign_id', 'is', null)
            .limit(5);

          if (otherLeadsError) {
            console.error('❌ Error fetching leads from other campaigns:', otherLeadsError);
          } else if (otherCampaignLeads && otherCampaignLeads.length > 0) {
            console.log(`🔄 Found ${otherCampaignLeads.length} leads from other campaigns, reassigning to current campaign`);
            
            // Reassign these leads to the current campaign
            const { error: reassignError } = await supabaseService
              .from('leads')
              .update({ 
                campaign_id: campaignId,
                call_status: 'pending',
                updated_at: new Date().toISOString()
              })
              .in('id', otherCampaignLeads.map(l => l.id));

            if (reassignError) {
              console.error('❌ Error reassigning leads to campaign:', reassignError);
            } else {
              console.log(`✅ Reassigned ${otherCampaignLeads.length} leads to campaign`);
              
              // Update campaign status
              await supabaseService
                .from('campaigns')
                .update({
                  status: 'active',
                  updated_at: new Date().toISOString()
                })
                .eq('id', campaignId);

              console.log(`✅ Campaign started with ${otherCampaignLeads.length} reassigned leads`);

              // Start calling process
              this.processCampaignCalls(campaignId);
              return;
            }
          }
        }

        throw new Error('No leads found for campaign. Please upload leads first.');
      }

      // Update campaign status
      await supabaseService
        .from('campaigns')
        .update({
          status: 'active',
          updated_at: new Date().toISOString()
        })
        .eq('id', campaignId);

      console.log(`✅ Campaign started with ${leads.length} leads`);

      // Start calling process (this would be done async in production)
      this.processCampaignCalls(campaignId);

    } catch (error) {
      console.error('❌ Error starting campaign:', error);
      throw error;
    }
  }

  /**
   * Process campaign calls (async background process)
   */
  private async processCampaignCalls(campaignId: string): Promise<void> {
    try {
      console.log(`🔄 Starting to process campaign calls for: ${campaignId}`);
      
      // This would typically be handled by a background job queue
      // For now, we'll process a few calls to demonstrate functionality
      
      const { data: leads } = await supabaseService
        .from('leads')
        .select('*')
        .eq('campaign_id', campaignId)
        .eq('call_status', 'pending')
        .limit(5);

      console.log(`📊 Found ${leads?.length || 0} pending leads for campaign ${campaignId}`);

      if (!leads || leads.length === 0) {
        console.log('⚠️ No pending leads found for processing');
        return;
      }

      const { data: campaign } = await supabaseService
        .from('campaigns')
        .select('assistant_id, phone_number_id')
        .eq('id', campaignId)
        .single();

      console.log(`📋 Campaign config:`, campaign);

      if (!campaign) {
        throw new Error('Campaign not found');
      }

      // Process each lead
      console.log(`🚀 Processing ${leads.length} leads...`);
      for (const lead of leads) {
        try {
          console.log(`📞 Processing lead: ${lead.first_name} ${lead.last_name} - ${lead.phone}`);
          await this.makeCall(campaignId, lead, campaign.assistant_id, campaign.phone_number_id);
          
          // Add delay between calls (respecting rate limits)
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (error) {
          console.error(`❌ Failed to call lead ${lead.id}:`, error);
        }
      }

      console.log(`✅ Finished processing campaign calls for: ${campaignId}`);

    } catch (error) {
      console.error('❌ Error processing campaign calls:', error);
    }
  }

  /**
   * Format phone number to E.164 international format
   */
  private formatPhoneNumber(phone: string): string {
    if (!phone) return '';
    
    // Remove all non-digit characters
    const cleaned = phone.replace(/\D/g, '');
    
    // If already starts with country code, add + prefix
    if (cleaned.length >= 10) {
      // Check for common country codes and formats
      if (cleaned.startsWith('1') && cleaned.length === 11) {
        // US/Canada: +1XXXXXXXXXX
        return `+${cleaned}`;
      } else if (cleaned.startsWith('44') && cleaned.length >= 11) {
        // UK: +44XXXXXXXXXX
        return `+${cleaned}`;
      } else if (cleaned.startsWith('356') && cleaned.length === 11) {
        // Malta: +356XXXXXXXX (exactly 11 digits total)
        return `+${cleaned}`;
      } else if (cleaned.startsWith('39') && cleaned.length >= 10) {
        // Italy: +39XXXXXXXXX
        return `+${cleaned}`;
      } else if (cleaned.startsWith('33') && cleaned.length >= 10) {
        // France: +33XXXXXXXXX
        return `+${cleaned}`;
      } else if (cleaned.startsWith('49') && cleaned.length >= 11) {
        // Germany: +49XXXXXXXXXX
        return `+${cleaned}`;
      } else if (cleaned.length >= 10) {
        // Default: assume it's already a country code
        return `+${cleaned}`;
      }
    }
    
    // Handle Malta numbers without country code (8 digits)
    if (cleaned.length === 8) {
      // Malta mobile numbers: 9XXXXXXX or 7XXXXXXX
      if (cleaned.startsWith('9') || cleaned.startsWith('7')) {
        return `+356${cleaned}`;
      }
    }
    
    // If no country code detected, assume UK for 10-digit numbers
    if (cleaned.length === 10) {
      return `+44${cleaned}`;
    } else if (cleaned.length === 11 && cleaned.startsWith('0')) {
      // UK number starting with 0, remove 0 and add +44
      return `+44${cleaned.substring(1)}`;
    }
    
    // Fallback: just add + if not present
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  }

  /**
   * Make a VAPI call to a lead
   */
  async makeCall(campaignId: string, lead: any, assistantId: string, phoneNumberId?: string): Promise<VAPICallResult> {
    try {
      console.log(`📞 Making call to ${lead.first_name} ${lead.last_name} at ${lead.phone}`);

      // Format phone number to E.164 international format
      const formattedPhone = this.formatPhoneNumber(lead.phone);
      console.log(`📱 Formatted phone number: "${lead.phone}" → "${formattedPhone}"`);

      // Ensure phone number has + prefix before sending to VAPI
      const vapiPhoneNumber = formattedPhone.startsWith('+') ? formattedPhone : `+${formattedPhone}`;
      console.log(`🚀 VAPI phone number: "${vapiPhoneNumber}"`);

      // Create VAPI call
      const callRequest = {
        assistantId,
        phoneNumberId,
        customer: {
          number: vapiPhoneNumber,
          name: `${lead.first_name} ${lead.last_name}`.trim(),
          email: lead.email || undefined
        }
      };

      console.log(`🚀 VAPI call request:`, JSON.stringify(callRequest, null, 2));

      let vapiCall;
      if (this.vapiService) {
        vapiCall = await this.vapiService.createCall(callRequest);
      } else {
        // Mock call for development without VAPI credentials
        vapiCall = {
          id: `mock-call-${Date.now()}`,
          status: 'queued',
          assistantId,
          customer: callRequest.customer
        };
        console.log('📞 Created mock call for development:', vapiCall.id);
      }

      // Record the call in our database
      const { data: callRecord, error: callError } = await supabaseService
        .from('calls')
        .insert({
          organization_id: this.organizationId,
          campaign_id: campaignId,
          lead_id: lead.id,
          vapi_call_id: vapiCall.id,
          direction: 'outbound',
          phone_number: formattedPhone,
          status: 'initiated', // Use valid database status
          started_at: new Date().toISOString(),
          cost: 0 // Will be updated when call completes
        })
        .select()
        .single();

      if (callError) {
        console.error('❌ Error recording call:', callError);
        throw new Error(`Failed to record call: ${callError.message}`);
      }

      // Update lead status
      await supabaseService
        .from('leads')
        .update({
          call_status: 'calling',
          updated_at: new Date().toISOString()
        })
        .eq('id', lead.id);

      console.log(`✅ Call initiated: ${vapiCall.id}`);

      // Start mock call simulation if this is a mock call
      if (!this.vapiService && vapiCall.id.startsWith('mock-call-')) {
        console.log('🎭 Starting mock call simulation...');
        const mockWebhookService = MockWebhookService.getInstance();
        await mockWebhookService.simulateCallProgression(vapiCall.id, this.organizationId);
      }

      return {
        leadId: lead.id,
        vapiCallId: vapiCall.id,
        status: 'pending',
        startedAt: new Date().toISOString()
      };

    } catch (error) {
      console.error('❌ Error making call:', error);
      
      // Update lead with failed status
      await supabaseService
        .from('leads')
        .update({
          call_status: 'failed',
          updated_at: new Date().toISOString()
        })
        .eq('id', lead.id);

      throw error;
    }
  }

  /**
   * Get campaign dashboard data
   */
  async getCampaignDashboard(campaignId: string): Promise<VAPIOutboundCampaign> {
    try {
      // Get campaign details
      const { data: campaign, error: campaignError } = await supabaseService
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .eq('organization_id', this.organizationId)
        .single();

      if (campaignError || !campaign) {
        throw new Error('Campaign not found');
      }

      // Get leads
      const { data: leads, error: leadsError } = await supabaseService
        .from('leads')
        .select('*')
        .eq('campaign_id', campaignId);

      if (leadsError) {
        throw new Error(`Failed to fetch leads: ${leadsError.message}`);
      }

      // Get calls
      const { data: calls, error: callsError } = await supabaseService
        .from('calls')
        .select('*')
        .eq('campaign_id', campaignId);

      if (callsError) {
        throw new Error(`Failed to fetch calls: ${callsError.message}`);
      }

      // Calculate metrics
      const metrics = this.calculateCampaignMetrics(leads || [], calls || []);

      // Transform leads
      const transformedLeads: VAPILead[] = (leads || []).map(lead => ({
        id: lead.id,
        firstName: lead.first_name,
        lastName: lead.last_name,
        phone: lead.phone,
        email: lead.email,
        company: lead.company,
        title: lead.job_title,
        customFields: lead.custom_fields || {},
        status: lead.call_status,
        callAttempts: lead.call_attempts || 0,
        lastCallAt: lead.last_call_at,
        nextCallAt: lead.next_call_at
      }));

      return {
        id: campaign.id,
        organizationId: this.organizationId,
        name: campaign.name,
        description: campaign.description,
        status: campaign.status,
        assistantId: campaign.assistant_id,
        phoneNumberId: campaign.phone_number_id,
        leads: transformedLeads,
        schedule: campaign.settings?.schedule,
        maxRetries: campaign.settings?.maxRetries || 3,
        retryDelay: campaign.settings?.retryDelay || 24,
        metrics
      };

    } catch (error) {
      console.error('❌ Error getting campaign dashboard:', error);
      throw error;
    }
  }

  /**
   * Get real-time campaign metrics
   */
  async getCampaignMetrics(campaignId: string): Promise<VAPICampaignMetrics> {
    try {
      const { data: leads } = await supabaseService
        .from('leads')
        .select('*')
        .eq('campaign_id', campaignId);

      const { data: calls } = await supabaseService
        .from('calls')
        .select('*')
        .eq('campaign_id', campaignId);

      return this.calculateCampaignMetrics(leads || [], calls || []);
    } catch (error) {
      console.error('❌ Error getting campaign metrics:', error);
      throw error;
    }
  }

  /**
   * Update campaign metrics in database
   */
  private async updateCampaignMetrics(campaignId: string): Promise<void> {
    try {
      const metrics = await this.getCampaignMetrics(campaignId);

      await supabaseService
        .from('campaigns')
        .update({
          total_calls: metrics.callsAttempted,
          successful_calls: metrics.callsConnected,
          total_duration: metrics.averageDuration * metrics.callsConnected,
          updated_at: new Date().toISOString()
        })
        .eq('id', campaignId);

    } catch (error) {
      console.error('❌ Error updating campaign metrics:', error);
    }
  }

  /**
   * Calculate campaign metrics from leads and calls data
   */
  private calculateCampaignMetrics(leads: any[], calls: any[]): VAPICampaignMetrics {
    const totalLeads = leads.length;
    const callsAttempted = calls.length;
    const callsConnected = calls.filter(call => 
      ['completed', 'connected'].includes(call.status)).length;
    const callsCompleted = calls.filter(call => call.status === 'completed').length;
    
    const connectionRate = callsAttempted > 0 ? (callsConnected / callsAttempted) * 100 : 0;
    const completionRate = totalLeads > 0 ? (callsCompleted / totalLeads) * 100 : 0;
    
    const totalDuration = calls.reduce((sum, call) => sum + (call.duration || 0), 0);
    const averageDuration = callsConnected > 0 ? totalDuration / callsConnected : 0;
    
    const totalCost = calls.reduce((sum, call) => sum + (call.cost || 0), 0);
    
    const positiveOutcomes = calls.filter(call => 
      ['interested', 'converted', 'callback'].includes(call.outcome)).length;
    const conversionRate = callsAttempted > 0 ? (positiveOutcomes / callsAttempted) * 100 : 0;
    
    const activeCalls = calls.filter(call => 
      ['queued', 'ringing', 'in-progress'].includes(call.status)).length;
    
    const today = new Date().toISOString().split('T')[0];
    const callsToday = calls.filter(call => 
      call.started_at?.startsWith(today)).length;
    
    const leadsRemaining = leads.filter(lead => 
      ['pending', 'no_answer', 'busy'].includes(lead.call_status)).length;

    return {
      totalLeads,
      callsAttempted,
      callsConnected,
      callsCompleted,
      connectionRate: Math.round(connectionRate * 100) / 100,
      completionRate: Math.round(completionRate * 100) / 100,
      averageDuration: Math.round(averageDuration),
      totalCost: Math.round(totalCost * 100) / 100,
      positiveOutcomes,
      conversionRate: Math.round(conversionRate * 100) / 100,
      activeCalls,
      callsToday,
      leadsRemaining
    };
  }

  /**
   * Pause a campaign
   */
  async pauseCampaign(campaignId: string): Promise<void> {
    try {
      await supabaseService
        .from('campaigns')
        .update({
          status: 'paused',
          updated_at: new Date().toISOString()
        })
        .eq('id', campaignId)
        .eq('organization_id', this.organizationId);

      console.log('⏸️ Campaign paused:', campaignId);
    } catch (error) {
      console.error('❌ Error pausing campaign:', error);
      throw error;
    }
  }

  /**
   * Resume a paused campaign
   */
  async resumeCampaign(campaignId: string): Promise<void> {
    try {
      await supabaseService
        .from('campaigns')
        .update({
          status: 'active',
          updated_at: new Date().toISOString()
        })
        .eq('id', campaignId)
        .eq('organization_id', this.organizationId);

      console.log('▶️ Campaign resumed:', campaignId);
      
      // Resume processing calls
      this.processCampaignCalls(campaignId);
    } catch (error) {
      console.error('❌ Error resuming campaign:', error);
      throw error;
    }
  }

  /**
   * Get live campaign monitoring data
   */
  async getLiveCampaignData(campaignId: string): Promise<{
    activeCalls: any[];
    recentCalls: any[];
    metrics: VAPICampaignMetrics;
  }> {
    try {
      // Get active calls
      const { data: activeCalls } = await supabaseService
        .from('calls')
        .select(`
          *,
          leads(first_name, last_name, phone, company)
        `)
        .eq('campaign_id', campaignId)
        .in('status', ['pending', 'queued', 'ringing', 'in-progress'])
        .order('started_at', { ascending: false });

      // Get recent completed calls
      const { data: recentCalls } = await supabaseService
        .from('calls')
        .select(`
          *,
          leads(first_name, last_name, phone, company)
        `)
        .eq('campaign_id', campaignId)
        .eq('status', 'completed')
        .order('ended_at', { ascending: false })
        .limit(10);

      // Get current metrics
      const metrics = await this.getCampaignMetrics(campaignId);

      return {
        activeCalls: activeCalls || [],
        recentCalls: recentCalls || [],
        metrics
      };

    } catch (error) {
      console.error('❌ Error getting live campaign data:', error);
      throw error;
    }
  }

  /**
   * Get VAPI call data (public method for API access)
   */
  async getVAPICallData(vapiCallId: string): Promise<any> {
    try {
      if (!this.vapiService) {
        return null;
      }
      
      return await this.vapiService.getCall(vapiCallId);
    } catch (error) {
      console.error('❌ Error getting VAPI call data:', error);
      return null;
    }
  }
} 