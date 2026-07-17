ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT "agent_runs_work_package_id_work_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_gates" DROP CONSTRAINT "approval_gates_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_gates" DROP CONSTRAINT "approval_gates_work_package_id_work_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_gates" DROP CONSTRAINT "approval_gates_source_agent_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_gates" DROP CONSTRAINT "approval_gates_source_artifact_id_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "artifacts" DROP CONSTRAINT "artifacts_agent_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "filesystem_mcp_grant_approvals" DROP CONSTRAINT "filesystem_mcp_grant_approvals_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "filesystem_mcp_grant_approvals" DROP CONSTRAINT "filesystem_mcp_grant_approvals_work_package_id_work_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "filesystem_mcp_runtime_audits" DROP CONSTRAINT "filesystem_mcp_runtime_audits_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "filesystem_mcp_runtime_audits" DROP CONSTRAINT "filesystem_mcp_runtime_audits_work_package_id_work_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "filesystem_mcp_runtime_audits" DROP CONSTRAINT "filesystem_mcp_runtime_audits_agent_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "filesystem_mcp_runtime_audits" DROP CONSTRAINT "filesystem_mcp_runtime_audits_grant_approval_id_filesystem_mcp_grant_approvals_id_fk";
--> statement-breakpoint
ALTER TABLE "project_mcp_status_checks" DROP CONSTRAINT "project_mcp_status_checks_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "repository_command_audits" DROP CONSTRAINT "repository_command_audits_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "repository_command_audits" DROP CONSTRAINT "repository_command_audits_work_package_id_work_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "repository_command_audits" DROP CONSTRAINT "repository_command_audits_agent_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "repository_command_audits" DROP CONSTRAINT "repository_command_audits_artifact_id_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "task_attempts" DROP CONSTRAINT "task_attempts_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "task_logs" DROP CONSTRAINT "task_logs_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "task_logs" DROP CONSTRAINT "task_logs_task_attempt_id_task_attempts_id_fk";
--> statement-breakpoint
ALTER TABLE "task_logs" DROP CONSTRAINT "task_logs_agent_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "task_logs" DROP CONSTRAINT "task_logs_work_package_id_work_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "task_logs" DROP CONSTRAINT "task_logs_artifact_id_artifacts_id_fk";
--> statement-breakpoint
ALTER TABLE "task_logs" DROP CONSTRAINT "task_logs_approval_gate_id_approval_gates_id_fk";
--> statement-breakpoint
ALTER TABLE "task_questions" DROP CONSTRAINT "task_questions_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "vcs_changes" DROP CONSTRAINT "vcs_changes_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "vcs_changes" DROP CONSTRAINT "vcs_changes_work_package_id_work_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "vcs_changes" DROP CONSTRAINT "vcs_changes_agent_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "work_package_dependencies" DROP CONSTRAINT "work_package_dependencies_work_package_id_work_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "work_package_dependencies" DROP CONSTRAINT "work_package_dependencies_depends_on_work_package_id_work_packages_id_fk";
--> statement-breakpoint
ALTER TABLE "work_packages" DROP CONSTRAINT "work_packages_task_id_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_gates" ADD CONSTRAINT "approval_gates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_gates" ADD CONSTRAINT "approval_gates_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_gates" ADD CONSTRAINT "approval_gates_source_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("source_agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_gates" ADD CONSTRAINT "approval_gates_source_artifact_id_artifacts_id_fk" FOREIGN KEY ("source_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filesystem_mcp_grant_approvals" ADD CONSTRAINT "filesystem_mcp_grant_approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filesystem_mcp_grant_approvals" ADD CONSTRAINT "filesystem_mcp_grant_approvals_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filesystem_mcp_runtime_audits" ADD CONSTRAINT "filesystem_mcp_runtime_audits_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filesystem_mcp_runtime_audits" ADD CONSTRAINT "filesystem_mcp_runtime_audits_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filesystem_mcp_runtime_audits" ADD CONSTRAINT "filesystem_mcp_runtime_audits_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filesystem_mcp_runtime_audits" ADD CONSTRAINT "filesystem_mcp_runtime_audits_grant_approval_id_filesystem_mcp_grant_approvals_id_fk" FOREIGN KEY ("grant_approval_id") REFERENCES "public"."filesystem_mcp_grant_approvals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_status_checks" ADD CONSTRAINT "project_mcp_status_checks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_command_audits" ADD CONSTRAINT "repository_command_audits_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_command_audits" ADD CONSTRAINT "repository_command_audits_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_command_audits" ADD CONSTRAINT "repository_command_audits_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_command_audits" ADD CONSTRAINT "repository_command_audits_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_attempts" ADD CONSTRAINT "task_attempts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_attempt_id_task_attempts_id_fk" FOREIGN KEY ("task_attempt_id") REFERENCES "public"."task_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_approval_gate_id_approval_gates_id_fk" FOREIGN KEY ("approval_gate_id") REFERENCES "public"."approval_gates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_questions" ADD CONSTRAINT "task_questions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_changes" ADD CONSTRAINT "vcs_changes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_changes" ADD CONSTRAINT "vcs_changes_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vcs_changes" ADD CONSTRAINT "vcs_changes_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_dependencies" ADD CONSTRAINT "work_package_dependencies_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_package_dependencies" ADD CONSTRAINT "work_package_dependencies_depends_on_work_package_id_work_packages_id_fk" FOREIGN KEY ("depends_on_work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "forge_epic_172_reject_project_hard_delete_v1"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
	RAISE EXCEPTION 'Forge project hard delete is disabled; archive the project so retained task and execution evidence stays queryable'
		USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "forge_epic_172_projects_no_hard_delete" ON "projects";
--> statement-breakpoint
CREATE TRIGGER "forge_epic_172_projects_no_hard_delete"
BEFORE DELETE ON "projects"
FOR EACH ROW EXECUTE FUNCTION "forge_epic_172_reject_project_hard_delete_v1"();
