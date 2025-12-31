# AWS Fargate Deployment Checklist

## Pre-Deployment (One-Time Setup)

### 1. AWS Account Setup
- [ ] AWS account created and billing enabled
- [ ] AWS CLI installed: `aws --version` shows v2.x
- [ ] AWS credentials configured: `aws configure`
- [ ] Verified access: `aws sts get-caller-identity`

### 2. Domain & SSL
- [ ] Domain name registered (e.g., classpilot.net)
- [ ] Domain DNS can be modified (access to registrar)
- [ ] Decision made: Use Route53 or external DNS provider

### 3. Database
- [ ] Neon PostgreSQL database created
- [ ] Database URL saved securely
- [ ] Database migrations applied: `npm run db:push`
- [ ] Connection tested from local machine

### 4. Google OAuth
- [ ] Google Cloud Project created
- [ ] OAuth 2.0 credentials created
- [ ] Authorized redirect URIs configured:
  - `https://yourdomain.com/auth/google/callback`
- [ ] Client ID and Secret saved securely

### 5. Environment Secrets
Generate and save these securely:
```bash
# Generate secrets
export SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export STUDENT_TOKEN_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export WS_SHARED_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
```

Required secrets:
- [ ] `SESSION_SECRET`
- [ ] `STUDENT_TOKEN_SECRET`
- [ ] `WS_SHARED_KEY`
- [ ] `GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY`
- [ ] `GOOGLE_CLIENT_ID`
- [ ] `GOOGLE_CLIENT_SECRET`
- [ ] `DATABASE_URL`

---

## AWS Infrastructure Setup (2-3 hours)

### Step 1: ECR Repository
```bash
export AWS_REGION=us-east-1
export ECR_REPO_NAME=classpilot
```

- [ ] ECR repository created: `aws ecr create-repository --repository-name ${ECR_REPO_NAME}`
- [ ] Repository URI saved: `__________________________`

### Step 2: VPC & Networking

**Option A: Default VPC** (Quick start - 15 min)
- [ ] Default VPC ID obtained
- [ ] Subnet IDs obtained (at least 2)

**Option B: Custom VPC** (Recommended - 30 min)
- [ ] VPC created (10.0.0.0/16)
- [ ] Internet Gateway created and attached
- [ ] 2 public subnets created (different AZs)
- [ ] Route table configured
- [ ] Subnets associated with route table

### Step 3: Security Groups
- [ ] ALB security group created
  - [ ] Port 80 (HTTP) allowed from 0.0.0.0/0
  - [ ] Port 443 (HTTPS) allowed from 0.0.0.0/0
- [ ] Fargate security group created
  - [ ] Port 5000 allowed from ALB security group

### Step 4: Application Load Balancer
- [ ] ALB created in 2+ availability zones
- [ ] ALB DNS name saved: `__________________________`
- [ ] Target group created (HTTP, port 5000, /health)
- [ ] HTTP listener created (port 80)

### Step 5: SSL Certificate
- [ ] ACM certificate requested for domain
- [ ] DNS validation records added to DNS provider
- [ ] Certificate status is "Issued"
- [ ] HTTPS listener created (port 443) with certificate
- [ ] HTTP listener configured to redirect to HTTPS

### Step 6: ECS Setup
- [ ] ECS cluster created: `classpilot-cluster`
- [ ] IAM role `ecsTaskExecutionRole` created
- [ ] Role has `AmazonECSTaskExecutionRolePolicy` attached
- [ ] CloudWatch log group created: `/ecs/classpilot`

### Step 7: Secrets Management
Store all secrets in AWS Systems Manager Parameter Store:

- [ ] `classpilot/DATABASE_URL`
- [ ] `classpilot/SESSION_SECRET`
- [ ] `classpilot/STUDENT_TOKEN_SECRET`
- [ ] `classpilot/WS_SHARED_KEY`
- [ ] `classpilot/GOOGLE_CLIENT_ID`
- [ ] `classpilot/GOOGLE_CLIENT_SECRET`
- [ ] `classpilot/GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY`

Commands:
```bash
aws ssm put-parameter --name "classpilot/DATABASE_URL" --value "YOUR_VALUE" --type SecureString
aws ssm put-parameter --name "classpilot/SESSION_SECRET" --value "YOUR_VALUE" --type SecureString
# ... repeat for all secrets
```

- [ ] IAM policy added to `ecsTaskExecutionRole` for SSM access

### Step 8: Task Definition
- [ ] Task definition JSON file created
- [ ] Image URI placeholder replaced with ECR URI
- [ ] Task execution role ARN updated
- [ ] AWS region updated
- [ ] All secret names match Parameter Store
- [ ] Task definition registered: `aws ecs register-task-definition --cli-input-json file://task-definition.json`

### Step 9: Deploy First Container
- [ ] Docker image built locally
- [ ] Logged into ECR: `aws ecr get-login-password | docker login ...`
- [ ] Image tagged and pushed to ECR
- [ ] ECS service created with 2 tasks minimum
- [ ] Service health checks passing

### Step 10: DNS Configuration
- [ ] Route53 hosted zone created (if using Route53)
- [ ] A record created pointing to ALB
- [ ] DNS propagation verified: `nslookup classpilot.net`
- [ ] HTTPS working: `https://classpilot.net/health` returns 200

---

## Post-Deployment Configuration

### Auto-Scaling
- [ ] Scalable target registered (min: 2, max: 10)
- [ ] CPU-based scaling policy created (target: 70%)
- [ ] Tested scaling by generating load

### Monitoring & Alerts
- [ ] CloudWatch dashboard created
- [ ] Alarms configured:
  - [ ] CPU utilization > 80%
  - [ ] Memory utilization > 80%
  - [ ] Unhealthy target count > 0
  - [ ] 5xx errors > 10/minute
- [ ] SNS topic created for alerts
- [ ] Email subscription to SNS topic confirmed

### Cost Management
- [ ] AWS Budgets configured ($100/month threshold)
- [ ] Budget alert email configured
- [ ] Cost Explorer reviewed

### Backup & Disaster Recovery
- [ ] Neon database automatic backups enabled
- [ ] Manual database snapshot created
- [ ] Backup restoration procedure documented
- [ ] RTO/RPO defined: `________`

---

## GitHub Actions CI/CD Setup

### Repository Secrets
Add these to GitHub Settings → Secrets and variables → Actions:

- [ ] `AWS_ACCESS_KEY_ID`
- [ ] `AWS_SECRET_ACCESS_KEY`

### Workflow Configuration
- [ ] `.github/workflows/deploy-fargate.yml` exists
- [ ] Workflow triggers on `main` branch push
- [ ] Workflow runs tests before deployment
- [ ] First deployment successful

### Test Deployment
- [ ] Make a code change
- [ ] Commit and push to `main`
- [ ] GitHub Actions workflow runs successfully
- [ ] New task definition deployed
- [ ] Service updated with zero downtime
- [ ] Health checks passing

---

## Application Verification

### Functional Testing
- [ ] Homepage loads: `https://classpilot.net`
- [ ] Login page accessible: `https://classpilot.net/login`
- [ ] Health check returns 200: `https://classpilot.net/health`
- [ ] Database connectivity confirmed (check health response)
- [ ] Google OAuth login works
- [ ] Chrome extension can connect
- [ ] WebSocket connections stable
- [ ] Student device registration works
- [ ] Teacher dashboard loads

### Performance Testing
- [ ] Response time < 500ms for /health
- [ ] Response time < 2s for authenticated pages
- [ ] WebSocket latency < 100ms
- [ ] Can handle 50 concurrent devices
- [ ] Memory usage stable over 1 hour

### Security Verification
- [ ] HTTP redirects to HTTPS
- [ ] SSL certificate valid (no browser warnings)
- [ ] Security headers present (check with securityheaders.com)
- [ ] CSRF protection working
- [ ] Rate limiting functional
- [ ] Demo users not created in production (check logs)

---

## Maintenance Procedures

### Regular Tasks

**Daily:**
- [ ] Check CloudWatch logs for errors
- [ ] Verify service health in ECS console
- [ ] Monitor costs in AWS Cost Explorer

**Weekly:**
- [ ] Review CloudWatch metrics
- [ ] Check for AWS security bulletins
- [ ] Verify backup status

**Monthly:**
- [ ] Review and optimize costs
- [ ] Update dependencies: `npm update`
- [ ] Rotate secrets (if company policy requires)
- [ ] Test disaster recovery procedure

### Update Application

1. Make code changes locally
2. Test locally: `docker build -t classpilot . && docker run -p 5000:5000 classpilot`
3. Commit and push to `main` branch
4. GitHub Actions automatically deploys
5. Verify deployment in AWS console
6. Check application health

---

## Rollback Procedure

If deployment fails or introduces bugs:

```bash
# Get previous task definition revision
aws ecs describe-services \
  --cluster classpilot-cluster \
  --services classpilot-service

# Update service to previous task definition
aws ecs update-service \
  --cluster classpilot-cluster \
  --service classpilot-service \
  --task-definition classpilot:PREVIOUS_REVISION

# Force new deployment
aws ecs update-service \
  --cluster classpilot-cluster \
  --service classpilot-service \
  --force-new-deployment
```

---

## Troubleshooting

### Tasks not starting
**Symptoms:** Tasks in PENDING or immediately STOPPED state

**Check:**
```bash
aws ecs describe-tasks --cluster classpilot-cluster --tasks TASK_ID
```

**Common causes:**
- [ ] ECR image not found or inaccessible
- [ ] Secrets not accessible (IAM permissions)
- [ ] Invalid task definition
- [ ] Insufficient resources in subnets

### Health checks failing
**Symptoms:** Targets marked unhealthy in target group

**Check:**
- [ ] Security group allows traffic on port 5000
- [ ] Application running on correct port
- [ ] /health endpoint returns 200
- [ ] CloudWatch logs show application errors

### High costs
**Check:**
- [ ] Number of running tasks (should be 2-4)
- [ ] NAT Gateway usage
- [ ] Data transfer costs
- [ ] CloudWatch log retention

**Fix:**
- Reduce task count during off-hours
- Use Fargate Spot for development
- Set CloudWatch log retention to 7 days

---

## Emergency Contacts

**AWS Support:** [1-year Support Plan recommended - $29/month]

**Key Personnel:**
- AWS Account Owner: `__________________________`
- Domain Registrar Contact: `__________________________`
- Database Admin: `__________________________`

**Important URLs:**
- AWS Console: https://console.aws.amazon.com
- Application: `https://classpilot.net`
- Neon Dashboard: `__________________________`
- GitHub Repository: `https://github.com/bzinkan/ClassPilot`

---

## Sign-Off

**Deployed by:** `__________________________`
**Date:** `__________________________`
**Deployment verified by:** `__________________________`
**Production ready:** ☐ Yes ☐ No

**Notes:**
```
[Add any deployment-specific notes or issues encountered]
```
