# AWS Fargate - Quick Start Guide

## TL;DR - Deploy in 3 Commands

```bash
# 1. Set your configuration
export AWS_REGION=us-east-1
export DOMAIN_NAME=classpilot.net

# 2. Follow the deployment guide
open AWS_DEPLOYMENT.md  # Read this step-by-step

# 3. Deploy
./deploy-to-fargate.sh
```

---

## Prerequisites Checklist

Before you start, you need:

- [ ] AWS account with credit card
- [ ] AWS CLI installed: `aws --version`
- [ ] Docker installed: `docker --version`
- [ ] Domain name (for SSL)
- [ ] Neon PostgreSQL database URL
- [ ] Google OAuth credentials
- [ ] 3-4 hours of focused time

---

## Cost: $60-95/month

| Component | Cost/month |
|-----------|------------|
| Fargate (2 tasks) | $30 |
| Load Balancer | $20 |
| Data & Logs | $10 |
| **Total** | **~$60** |

**Auto-scaling:** Up to $95/month during peak usage

---

## Deployment Steps

### 1. Pre-Deployment (30 min)

```bash
# Install AWS CLI
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# Configure
aws configure
# Enter: Access Key, Secret Key, Region (us-east-1), Output (json)

# Generate secrets
node -e "
console.log('Copy these to a secure location:');
console.log('SESSION_SECRET:', require('crypto').randomBytes(32).toString('base64'));
console.log('STUDENT_TOKEN_SECRET:', require('crypto').randomBytes(32).toString('base64'));
console.log('WS_SHARED_KEY:', require('crypto').randomBytes(32).toString('base64'));
console.log('GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY:', require('crypto').randomBytes(32).toString('base64'));
"
```

### 2. AWS Infrastructure Setup (2 hours)

**Follow AWS_DEPLOYMENT.md section by section:**

1. Create ECR repository (5 min)
2. Set up VPC & networking (20 min)
3. Create security groups (10 min)
4. Create load balancer (15 min)
5. Request SSL certificate (15 min + validation time)
6. Create ECS cluster (5 min)
7. Store secrets in Parameter Store (15 min)
8. Register task definition (10 min)
9. Create ECS service (15 min)
10. Configure DNS (10 min)

### 3. First Deployment (30 min)

```bash
# Build and push image
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REPO_URI="${AWS_ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com/classpilot"

docker build -t classpilot:latest .
docker tag classpilot:latest ${ECR_REPO_URI}:latest
docker push ${ECR_REPO_URI}:latest

# Deploy
./deploy-to-fargate.sh
```

### 4. Verification (15 min)

```bash
# Check health
curl https://your-domain.com/health

# View logs
aws logs tail /ecs/classpilot --follow

# Test login
open https://your-domain.com/login
```

---

## Environment Variables Needed

Store these in AWS Systems Manager Parameter Store:

```bash
# Required
DATABASE_URL                      # From Neon
SESSION_SECRET                    # Generate with crypto
STUDENT_TOKEN_SECRET              # Generate with crypto
WS_SHARED_KEY                     # Generate with crypto
GOOGLE_CLIENT_ID                  # From Google Cloud Console
GOOGLE_CLIENT_SECRET              # From Google Cloud Console
GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY # Generate with crypto

# Optional
SENTRY_DSN_SERVER                 # For error tracking
PUBLIC_BASE_URL                   # Your domain (auto-detected)
```

---

## Common Commands

### View Logs
```bash
aws logs tail /ecs/classpilot --follow
```

### Check Service Status
```bash
aws ecs describe-services \
  --cluster classpilot-cluster \
  --services classpilot-service
```

### Update Application
```bash
./deploy-to-fargate.sh
```

### Scale Up/Down
```bash
# Scale to 4 tasks
aws ecs update-service \
  --cluster classpilot-cluster \
  --service classpilot-service \
  --desired-count 4
```

### Rollback to Previous Version
```bash
# Find previous task definition
aws ecs list-task-definitions --family-prefix classpilot

# Update service
aws ecs update-service \
  --cluster classpilot-cluster \
  --service classpilot-service \
  --task-definition classpilot:PREVIOUS_REVISION
```

---

## Troubleshooting

### Tasks not starting?
```bash
# Get task ID
TASK_ID=$(aws ecs list-tasks --cluster classpilot-cluster --service-name classpilot-service --query 'taskArns[0]' --output text)

# Check why it failed
aws ecs describe-tasks --cluster classpilot-cluster --tasks $TASK_ID
```

**Common causes:**
- ECR image not accessible → Check IAM permissions
- Secrets not found → Verify Parameter Store names
- Out of capacity → Try different availability zone

### Health checks failing?
```bash
# Check target health
aws elbv2 describe-target-health \
  --target-group-arn $(aws elbv2 describe-target-groups --names classpilot-tg --query 'TargetGroups[0].TargetGroupArn' --output text)
```

**Common causes:**
- Security group blocking port 5000
- Application not listening on correct port
- Database connection failing

### High costs?
```bash
# Check running tasks
aws ecs describe-services \
  --cluster classpilot-cluster \
  --services classpilot-service \
  --query 'services[0].{DesiredCount:desiredCount,RunningCount:runningCount}'
```

Should show 2-4 tasks. If more, reduce desired count.

---

## CI/CD Setup (GitHub Actions)

Add these secrets to GitHub repo:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

Then just:
```bash
git add .
git commit -m "Deploy to production"
git push origin main
```

GitHub Actions will automatically:
1. Run tests
2. Build Docker image
3. Push to ECR
4. Deploy to Fargate
5. Verify deployment

---

## Monitoring

### CloudWatch Dashboards
```bash
# View in console
open https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:
```

### Set Up Alerts
```bash
# CPU > 80%
aws cloudwatch put-metric-alarm \
  --alarm-name classpilot-high-cpu \
  --metric-name CPUUtilization \
  --namespace AWS/ECS \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2
```

---

## Cost Optimization

### 1. Use Fargate Spot (50% savings)
```bash
# Update service to use Spot
aws ecs update-service \
  --cluster classpilot-cluster \
  --service classpilot-service \
  --capacity-provider-strategy capacityProvider=FARGATE_SPOT,weight=1
```

### 2. Reduce Log Retention
```bash
aws logs put-retention-policy \
  --log-group-name /ecs/classpilot \
  --retention-in-days 7
```
Saves ~$10/month

### 3. Scale Down at Night
Set up CloudWatch Events to scale to 1 task midnight-6am.

**Potential savings:** $20-30/month total

---

## Need Help?

**Documentation:**
- Full guide: `AWS_DEPLOYMENT.md`
- Checklist: `DEPLOYMENT_CHECKLIST.md`
- Summary: `FARGATE_MIGRATION_SUMMARY.md`

**AWS Resources:**
- Console: https://console.aws.amazon.com
- Documentation: https://docs.aws.amazon.com/fargate/
- Support: https://console.aws.amazon.com/support/

**Emergency Rollback:**
1. Update DNS back to Replit
2. Investigate issue in CloudWatch logs
3. Fix and redeploy

---

## Success Criteria

After deployment, verify:

- [ ] `https://your-domain.com/health` returns 200
- [ ] Can login with Google OAuth
- [ ] Chrome extension connects
- [ ] WebSocket connections stable
- [ ] No errors in CloudWatch logs
- [ ] 2 tasks running in ECS
- [ ] CloudWatch alarms configured
- [ ] Monthly cost < $100

**All checked?** 🎉 **You're live on AWS Fargate!**
