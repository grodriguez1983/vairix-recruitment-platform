export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_users: {
        Row: {
          auth_user_id: string
          created_at: string
          deactivated_at: string | null
          email: string
          full_name: string | null
          id: string
          role: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          auth_user_id: string
          created_at?: string
          deactivated_at?: string | null
          email: string
          full_name?: string | null
          id?: string
          role: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          auth_user_id?: string
          created_at?: string
          deactivated_at?: string | null
          email?: string
          full_name?: string | null
          id?: string
          role?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      applications: {
        Row: {
          candidate_id: string
          cover_letter: string | null
          created_at: string
          deleted_at: string | null
          hired_at: string | null
          id: string
          job_id: string | null
          raw_data: Json | null
          rejected_at: string | null
          source: string | null
          stage_id: string | null
          stage_name: string | null
          status: string | null
          synced_at: string
          teamtailor_id: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          candidate_id: string
          cover_letter?: string | null
          created_at?: string
          deleted_at?: string | null
          hired_at?: string | null
          id?: string
          job_id?: string | null
          raw_data?: Json | null
          rejected_at?: string | null
          source?: string | null
          stage_id?: string | null
          stage_name?: string | null
          status?: string | null
          synced_at?: string
          teamtailor_id: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          candidate_id?: string
          cover_letter?: string | null
          created_at?: string
          deleted_at?: string | null
          hired_at?: string | null
          id?: string
          job_id?: string | null
          raw_data?: Json | null
          rejected_at?: string | null
          source?: string | null
          stage_id?: string | null
          stage_name?: string | null
          status?: string | null
          synced_at?: string
          teamtailor_id?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "applications_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "stages"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_custom_field_values: {
        Row: {
          candidate_id: string
          created_at: string
          custom_field_id: string
          field_type: string
          id: string
          raw_value: string | null
          synced_at: string
          teamtailor_value_id: string
          tenant_id: string | null
          updated_at: string
          value_boolean: boolean | null
          value_date: string | null
          value_number: number | null
          value_text: string | null
        }
        Insert: {
          candidate_id: string
          created_at?: string
          custom_field_id: string
          field_type: string
          id?: string
          raw_value?: string | null
          synced_at?: string
          teamtailor_value_id: string
          tenant_id?: string | null
          updated_at?: string
          value_boolean?: boolean | null
          value_date?: string | null
          value_number?: number | null
          value_text?: string | null
        }
        Update: {
          candidate_id?: string
          created_at?: string
          custom_field_id?: string
          field_type?: string
          id?: string
          raw_value?: string | null
          synced_at?: string
          teamtailor_value_id?: string
          tenant_id?: string | null
          updated_at?: string
          value_boolean?: boolean | null
          value_date?: string | null
          value_number?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_custom_field_values_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_custom_field_values_custom_field_id_fkey"
            columns: ["custom_field_id"]
            isOneToOne: false
            referencedRelation: "custom_fields"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_experiences: {
        Row: {
          candidate_id: string
          company: string | null
          created_at: string
          description: string | null
          end_date: string | null
          extraction_id: string
          id: string
          kind: string
          merged_from_ids: string[] | null
          source_variant: string
          start_date: string | null
          tenant_id: string | null
          title: string | null
        }
        Insert: {
          candidate_id: string
          company?: string | null
          created_at?: string
          description?: string | null
          end_date?: string | null
          extraction_id: string
          id?: string
          kind: string
          merged_from_ids?: string[] | null
          source_variant: string
          start_date?: string | null
          tenant_id?: string | null
          title?: string | null
        }
        Update: {
          candidate_id?: string
          company?: string | null
          created_at?: string
          description?: string | null
          end_date?: string | null
          extraction_id?: string
          id?: string
          kind?: string
          merged_from_ids?: string[] | null
          source_variant?: string
          start_date?: string | null
          tenant_id?: string | null
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_experiences_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_experiences_extraction_id_fkey"
            columns: ["extraction_id"]
            isOneToOne: false
            referencedRelation: "candidate_extractions"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_extractions: {
        Row: {
          candidate_id: string
          content_hash: string
          created_at: string
          extracted_at: string
          file_id: string
          id: string
          model: string
          prompt_version: string
          raw_output: Json
          source_variant: string
          tenant_id: string | null
        }
        Insert: {
          candidate_id: string
          content_hash: string
          created_at?: string
          extracted_at?: string
          file_id: string
          id?: string
          model: string
          prompt_version: string
          raw_output: Json
          source_variant: string
          tenant_id?: string | null
        }
        Update: {
          candidate_id?: string
          content_hash?: string
          created_at?: string
          extracted_at?: string
          file_id?: string
          id?: string
          model?: string
          prompt_version?: string
          raw_output?: Json
          source_variant?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "candidate_extractions_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_extractions_file_id_fkey"
            columns: ["file_id"]
            isOneToOne: false
            referencedRelation: "files"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_tags: {
        Row: {
          candidate_id: string
          confidence: number | null
          created_at: string
          created_by: string | null
          source: string | null
          tag_id: string
        }
        Insert: {
          candidate_id: string
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          source?: string | null
          tag_id: string
        }
        Update: {
          candidate_id?: string
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          source?: string | null
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_tags_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_tags_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      candidates: {
        Row: {
          created_at: string
          deleted_at: string | null
          email: string | null
          first_name: string | null
          id: string
          last_name: string | null
          linkedin_url: string | null
          phone: string | null
          pitch: string | null
          raw_data: Json | null
          sourced: boolean | null
          synced_at: string
          teamtailor_id: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          phone?: string | null
          pitch?: string | null
          raw_data?: Json | null
          sourced?: boolean | null
          synced_at?: string
          teamtailor_id: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string | null
          email?: string | null
          first_name?: string | null
          id?: string
          last_name?: string | null
          linkedin_url?: string | null
          phone?: string | null
          pitch?: string | null
          raw_data?: Json | null
          sourced?: boolean | null
          synced_at?: string
          teamtailor_id?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      custom_fields: {
        Row: {
          api_name: string
          created_at: string
          field_type: string
          id: string
          is_private: boolean
          is_searchable: boolean
          name: string
          owner_type: string
          raw_data: Json | null
          synced_at: string
          teamtailor_id: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          api_name: string
          created_at?: string
          field_type: string
          id?: string
          is_private?: boolean
          is_searchable?: boolean
          name: string
          owner_type: string
          raw_data?: Json | null
          synced_at?: string
          teamtailor_id: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          api_name?: string
          created_at?: string
          field_type?: string
          id?: string
          is_private?: boolean
          is_searchable?: boolean
          name?: string
          owner_type?: string
          raw_data?: Json | null
          synced_at?: string
          teamtailor_id?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      embeddings: {
        Row: {
          candidate_id: string
          content: string
          content_hash: string
          created_at: string
          embedding: string | null
          id: string
          model: string
          source_id: string | null
          source_type: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          candidate_id: string
          content: string
          content_hash: string
          created_at?: string
          embedding?: string | null
          id?: string
          model?: string
          source_id?: string | null
          source_type: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          candidate_id?: string
          content?: string
          content_hash?: string
          created_at?: string
          embedding?: string | null
          id?: string
          model?: string
          source_id?: string | null
          source_type?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "embeddings_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      evaluation_answers: {
        Row: {
          created_at: string
          evaluation_id: string
          id: string
          question_title: string | null
          question_tt_id: string
          question_type: string | null
          raw_data: Json | null
          synced_at: string
          teamtailor_answer_id: string
          tenant_id: string | null
          updated_at: string
          value_boolean: boolean | null
          value_date: string | null
          value_number: number | null
          value_range: number | null
          value_text: string | null
        }
        Insert: {
          created_at?: string
          evaluation_id: string
          id?: string
          question_title?: string | null
          question_tt_id: string
          question_type?: string | null
          raw_data?: Json | null
          synced_at?: string
          teamtailor_answer_id: string
          tenant_id?: string | null
          updated_at?: string
          value_boolean?: boolean | null
          value_date?: string | null
          value_number?: number | null
          value_range?: number | null
          value_text?: string | null
        }
        Update: {
          created_at?: string
          evaluation_id?: string
          id?: string
          question_title?: string | null
          question_tt_id?: string
          question_type?: string | null
          raw_data?: Json | null
          synced_at?: string
          teamtailor_answer_id?: string
          tenant_id?: string | null
          updated_at?: string
          value_boolean?: boolean | null
          value_date?: string | null
          value_number?: number | null
          value_range?: number | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "evaluation_answers_evaluation_id_fkey"
            columns: ["evaluation_id"]
            isOneToOne: false
            referencedRelation: "evaluations"
            referencedColumns: ["id"]
          },
        ]
      }
      evaluations: {
        Row: {
          application_id: string | null
          candidate_id: string
          created_at: string
          decision: string | null
          deleted_at: string | null
          evaluator_name: string | null
          id: string
          needs_review: boolean | null
          normalization_attempted_at: string | null
          notes: string | null
          raw_data: Json | null
          rejection_category_id: string | null
          rejection_reason: string | null
          score: number | null
          synced_at: string
          teamtailor_id: string | null
          tenant_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          application_id?: string | null
          candidate_id: string
          created_at?: string
          decision?: string | null
          deleted_at?: string | null
          evaluator_name?: string | null
          id?: string
          needs_review?: boolean | null
          normalization_attempted_at?: string | null
          notes?: string | null
          raw_data?: Json | null
          rejection_category_id?: string | null
          rejection_reason?: string | null
          score?: number | null
          synced_at?: string
          teamtailor_id?: string | null
          tenant_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          application_id?: string | null
          candidate_id?: string
          created_at?: string
          decision?: string | null
          deleted_at?: string | null
          evaluator_name?: string | null
          id?: string
          needs_review?: boolean | null
          normalization_attempted_at?: string | null
          notes?: string | null
          raw_data?: Json | null
          rejection_category_id?: string | null
          rejection_reason?: string | null
          score?: number | null
          synced_at?: string
          teamtailor_id?: string | null
          tenant_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "evaluations_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evaluations_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evaluations_rejection_category_id_fkey"
            columns: ["rejection_category_id"]
            isOneToOne: false
            referencedRelation: "rejection_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evaluations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      experience_skills: {
        Row: {
          created_at: string
          experience_id: string
          id: string
          resolved_at: string | null
          skill_id: string | null
          skill_raw: string
        }
        Insert: {
          created_at?: string
          experience_id: string
          id?: string
          resolved_at?: string | null
          skill_id?: string | null
          skill_raw: string
        }
        Update: {
          created_at?: string
          experience_id?: string
          id?: string
          resolved_at?: string | null
          skill_id?: string | null
          skill_raw?: string
        }
        Relationships: [
          {
            foreignKeyName: "experience_skills_experience_id_fkey"
            columns: ["experience_id"]
            isOneToOne: false
            referencedRelation: "candidate_experiences"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "experience_skills_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
        ]
      }
      files: {
        Row: {
          candidate_id: string
          content_hash: string | null
          created_at: string
          deleted_at: string | null
          file_size_bytes: number | null
          file_type: string | null
          id: string
          is_internal: boolean
          kind: string
          parse_error: string | null
          parsed_at: string | null
          parsed_text: string | null
          raw_data: Json | null
          storage_path: string
          synced_at: string
          teamtailor_id: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          candidate_id: string
          content_hash?: string | null
          created_at?: string
          deleted_at?: string | null
          file_size_bytes?: number | null
          file_type?: string | null
          id?: string
          is_internal?: boolean
          kind?: string
          parse_error?: string | null
          parsed_at?: string | null
          parsed_text?: string | null
          raw_data?: Json | null
          storage_path: string
          synced_at?: string
          teamtailor_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          candidate_id?: string
          content_hash?: string | null
          created_at?: string
          deleted_at?: string | null
          file_size_bytes?: number | null
          file_type?: string | null
          id?: string
          is_internal?: boolean
          kind?: string
          parse_error?: string | null
          parsed_at?: string | null
          parsed_text?: string | null
          raw_data?: Json | null
          storage_path?: string
          synced_at?: string
          teamtailor_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "files_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          body: string | null
          created_at: string
          deleted_at: string | null
          department: string | null
          id: string
          location: string | null
          pitch: string | null
          raw_data: Json | null
          status: string | null
          synced_at: string
          teamtailor_id: string
          tenant_id: string | null
          title: string
          updated_at: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          deleted_at?: string | null
          department?: string | null
          id?: string
          location?: string | null
          pitch?: string | null
          raw_data?: Json | null
          status?: string | null
          synced_at?: string
          teamtailor_id: string
          tenant_id?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          body?: string | null
          created_at?: string
          deleted_at?: string | null
          department?: string | null
          id?: string
          location?: string | null
          pitch?: string | null
          raw_data?: Json | null
          status?: string | null
          synced_at?: string
          teamtailor_id?: string
          tenant_id?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      notes: {
        Row: {
          application_id: string | null
          author_name: string | null
          body: string
          candidate_id: string
          created_at: string
          deleted_at: string | null
          id: string
          raw_data: Json | null
          synced_at: string
          teamtailor_id: string | null
          tenant_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          application_id?: string | null
          author_name?: string | null
          body: string
          candidate_id: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          raw_data?: Json | null
          synced_at?: string
          teamtailor_id?: string | null
          tenant_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          application_id?: string | null
          author_name?: string | null
          body?: string
          candidate_id?: string
          created_at?: string
          deleted_at?: string | null
          id?: string
          raw_data?: Json | null
          synced_at?: string
          teamtailor_id?: string | null
          tenant_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notes_application_id_fkey"
            columns: ["application_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      rejection_categories: {
        Row: {
          code: string
          created_at: string
          deprecated_at: string | null
          description: string | null
          display_name: string
          id: string
          sort_order: number | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          deprecated_at?: string | null
          description?: string | null
          display_name: string
          id?: string
          sort_order?: number | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          deprecated_at?: string | null
          description?: string | null
          display_name?: string
          id?: string
          sort_order?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      shortlist_candidates: {
        Row: {
          added_at: string
          added_by: string
          candidate_id: string
          note: string | null
          shortlist_id: string
        }
        Insert: {
          added_at?: string
          added_by: string
          candidate_id: string
          note?: string | null
          shortlist_id: string
        }
        Update: {
          added_at?: string
          added_by?: string
          candidate_id?: string
          note?: string | null
          shortlist_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shortlist_candidates_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shortlist_candidates_candidate_id_fkey"
            columns: ["candidate_id"]
            isOneToOne: false
            referencedRelation: "candidates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shortlist_candidates_shortlist_id_fkey"
            columns: ["shortlist_id"]
            isOneToOne: false
            referencedRelation: "shortlists"
            referencedColumns: ["id"]
          },
        ]
      }
      shortlists: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string
          description: string | null
          id: string
          job_id: string | null
          name: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          job_id?: string | null
          name: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          job_id?: string | null
          name?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shortlists_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shortlists_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      skill_aliases: {
        Row: {
          alias_normalized: string
          created_at: string
          id: string
          skill_id: string
          source: string
        }
        Insert: {
          alias_normalized: string
          created_at?: string
          id?: string
          skill_id: string
          source: string
        }
        Update: {
          alias_normalized?: string
          created_at?: string
          id?: string
          skill_id?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "skill_aliases_skill_id_fkey"
            columns: ["skill_id"]
            isOneToOne: false
            referencedRelation: "skills"
            referencedColumns: ["id"]
          },
        ]
      }
      skills: {
        Row: {
          canonical_name: string
          category: string | null
          created_at: string
          deprecated_at: string | null
          id: string
          slug: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          canonical_name: string
          category?: string | null
          created_at?: string
          deprecated_at?: string | null
          id?: string
          slug: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          canonical_name?: string
          category?: string | null
          created_at?: string
          deprecated_at?: string | null
          id?: string
          slug?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      skills_blacklist: {
        Row: {
          alias_normalized: string
          created_at: string
          id: string
          reason: string | null
        }
        Insert: {
          alias_normalized: string
          created_at?: string
          id?: string
          reason?: string | null
        }
        Update: {
          alias_normalized?: string
          created_at?: string
          id?: string
          reason?: string | null
        }
        Relationships: []
      }
      stages: {
        Row: {
          category: string | null
          created_at: string
          id: string
          job_id: string | null
          name: string
          position: number | null
          raw_data: Json | null
          slug: string | null
          synced_at: string
          teamtailor_id: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          name: string
          position?: number | null
          raw_data?: Json | null
          slug?: string | null
          synced_at?: string
          teamtailor_id: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: string
          job_id?: string | null
          name?: string
          position?: number | null
          raw_data?: Json | null
          slug?: string | null
          synced_at?: string
          teamtailor_id?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stages_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_errors: {
        Row: {
          created_at: string
          entity: string
          error_code: string | null
          error_message: string | null
          id: string
          payload: Json | null
          resolved_at: string | null
          run_started_at: string
          teamtailor_id: string | null
        }
        Insert: {
          created_at?: string
          entity: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          payload?: Json | null
          resolved_at?: string | null
          run_started_at: string
          teamtailor_id?: string | null
        }
        Update: {
          created_at?: string
          entity?: string
          error_code?: string | null
          error_message?: string | null
          id?: string
          payload?: Json | null
          resolved_at?: string | null
          run_started_at?: string
          teamtailor_id?: string | null
        }
        Relationships: []
      }
      sync_state: {
        Row: {
          entity: string
          id: string
          last_cursor: string | null
          last_run_error: string | null
          last_run_finished: string | null
          last_run_started: string | null
          last_run_status: string | null
          last_synced_at: string | null
          records_synced: number | null
          stale_timeout_minutes: number | null
          updated_at: string
        }
        Insert: {
          entity: string
          id?: string
          last_cursor?: string | null
          last_run_error?: string | null
          last_run_finished?: string | null
          last_run_started?: string | null
          last_run_status?: string | null
          last_synced_at?: string | null
          records_synced?: number | null
          stale_timeout_minutes?: number | null
          updated_at?: string
        }
        Update: {
          entity?: string
          id?: string
          last_cursor?: string | null
          last_run_error?: string | null
          last_run_finished?: string | null
          last_run_started?: string | null
          last_run_status?: string | null
          last_synced_at?: string | null
          records_synced?: number | null
          stale_timeout_minutes?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      tags: {
        Row: {
          category: string | null
          created_at: string
          id: string
          name: string
          tenant_id: string | null
        }
        Insert: {
          category?: string | null
          created_at?: string
          id?: string
          name: string
          tenant_id?: string | null
        }
        Update: {
          category?: string | null
          created_at?: string
          id?: string
          name?: string
          tenant_id?: string | null
        }
        Relationships: []
      }
      users: {
        Row: {
          active: boolean | null
          created_at: string
          email: string | null
          full_name: string | null
          id: string
          raw_data: Json | null
          role: string | null
          synced_at: string
          teamtailor_id: string
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          raw_data?: Json | null
          role?: string | null
          synced_at?: string
          teamtailor_id: string
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean | null
          created_at?: string
          email?: string | null
          full_name?: string | null
          id?: string
          raw_data?: Json | null
          role?: string | null
          synced_at?: string
          teamtailor_id?: string
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_app_role: { Args: never; Returns: string }
      resolve_skill: { Args: { raw: string }; Returns: string }
      semantic_search_embeddings: {
        Args: {
          candidate_id_filter?: string[]
          max_results?: number
          query_embedding: number[]
          source_type_filter?: string[]
        }
        Returns: {
          candidate_id: string
          score: number
          source_type: string
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

