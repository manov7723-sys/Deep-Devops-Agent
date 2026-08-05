"""
Knowledge Base for DevOps Agent
Contains AWS infrastructure knowledge, Terraform best practices, and company policies.
This is separate from the system prompt — it provides factual reference data.

The agent uses this knowledge to:
- Recommend appropriate instance types, AMIs, and configurations
- Generate correct Terraform HCL
- Follow AWS best practices for security, networking, and cost optimization
- Troubleshoot common issues
- Understand Kubernetes concepts and configurations
"""

# ═══════════════════════════════════════════════════════════════════════════════
# AWS REGIONS REFERENCE               
# ═══════════════════════════════════════════════════════════════════════════════

AWS_REGIONS = {
    "us-east-1": {"name": "US East (N. Virginia)", "continent": "North America", "az_count": 6},
    "us-east-2": {"name": "US East (Ohio)", "continent": "North America", "az_count": 3},
    "us-west-1": {"name": "US West (N. California)", "continent": "North America", "az_count": 3},
    "us-west-2": {"name": "US West (Oregon)", "continent": "North America", "az_count": 4},
    "eu-west-1": {"name": "Europe (Ireland)", "continent": "Europe", "az_count": 3},
    "eu-west-2": {"name": "Europe (London)", "continent": "Europe", "az_count": 3},
    "eu-west-3": {"name": "Europe (Paris)", "continent": "Europe", "az_count": 3},
    "eu-central-1": {"name": "Europe (Frankfurt)", "continent": "Europe", "az_count": 3},
    "eu-north-1": {"name": "Europe (Stockholm)", "continent": "Europe", "az_count": 3},
    "ap-south-1": {"name": "Asia Pacific (Mumbai)", "continent": "Asia Pacific", "az_count": 3},
    "ap-southeast-1": {"name": "Asia Pacific (Singapore)", "continent": "Asia Pacific", "az_count": 3},
    "ap-southeast-2": {"name": "Asia Pacific (Sydney)", "continent": "Asia Pacific", "az_count": 3},
    "ap-northeast-1": {"name": "Asia Pacific (Tokyo)", "continent": "Asia Pacific", "az_count": 3},
    "ap-northeast-2": {"name": "Asia Pacific (Seoul)", "continent": "Asia Pacific", "az_count": 3},
    "sa-east-1": {"name": "South America (Sao Paulo)", "continent": "South America", "az_count": 3},
    "ca-central-1": {"name": "Canada (Central)", "continent": "North America", "az_count": 3},
    "me-south-1": {"name": "Middle East (Bahrain)", "continent": "Middle East", "az_count": 3},
    "af-south-1": {"name": "Africa (Cape Town)", "continent": "Africa", "az_count": 3},
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1: AWS COMPUTE SERVICES
# ═══════════════════════════════════════════════════════════════════════════════

AWS_COMPUTE_SERVICES = {
    "ec2": {
        "full_name": "Elastic Compute Cloud",
        "description": "Virtual servers (instances) in the cloud",
        "use_cases": ["Web servers", "Application servers", "Dev/test environments", "Batch processing", "Enterprise applications"],
        "key_concepts": ["Instances", "AMIs", "Key pairs", "Security groups", "Elastic IPs", "Placement groups", "Auto Scaling"],
        "instance_families": {
            "t3/t3a": "Burstable — cost-effective for variable workloads",
            "m5/m6i": "General purpose — balanced compute, memory, networking",
            "c5/c6i": "Compute optimized — CPU-intensive tasks",
            "r5/r6i": "Memory optimized — databases, in-memory caching",
            "i3/i4i": "Storage optimized — high sequential read/write",
            "p4/p5": "Accelerated computing — ML training, HPC",
            "g5": "Graphics — ML inference, video encoding",
            "x1e": "Memory optimized — SAP HANA, large in-memory databases",
        },
        "pricing_models": {
            "on_demand": "Pay per second, no commitment",
            "reserved_1yr": "Up to 40% savings, 1-year commitment",
            "reserved_3yr": "Up to 60% savings, 3-year commitment",
            "spot": "Up to 90% savings, can be interrupted",
            "savings_plans": "Flexible commitment-based discounts",
        },
        "terraform_resource": "aws_instance",
        "terraform_data_source": "aws_ami",
    },

    "lambda": {
        "full_name": "AWS Lambda",
        "description": "Serverless compute — run code without provisioning servers",
        "use_cases": ["API backends", "Event-driven processing", "ETL pipelines", "Chatbots", "Scheduled tasks", "File processing"],
        "key_concepts": ["Function", "Handler", "Runtime", "Memory/timeout", "Layers", "SnapStart", "Provisioned concurrency", "Destination", "Event source mapping"],
        "limits": {
            "memory": "128 MB - 10,240 MB",
            "timeout": "Up to 900 seconds (15 min)",
            "package_size": "250 MB (unzipped)",
            "ephemeral_storage": "512 MB - 10,240 MB",
            "concurrent_executions": "1,000 (soft limit, can increase)",
            "layers": "6 layers per function",
            "storage_total": "75 GB (code + layers)",
        },
        "runtimes": ["python3.12", "python3.11", "python3.10", "nodejs20.x", "nodejs18.x", "java21", "java17", "go1.x", "dotnet8", "dotnet6", "ruby3.3"],
        "integration_events": ["API Gateway", "S3", "DynamoDB Streams", "SQS", "SNS", "EventBridge", "CloudWatch Events", "IoT", "Kinesis", "SES"],
        "terraform_resource": "aws_lambda_function",
    },

    "ecs": {
        "full_name": "Elastic Container Service",
        "description": "Container orchestration service for Docker containers",
        "use_cases": ["Microservices", "Web applications", "Batch processing", "CI/CD workloads"],
        "key_concepts": ["Cluster", "Service", "Task Definition", "Container", "Launch Type", "Service Discovery", "Service Connect"],
        "launch_types": {
            "FARGATE": {"description": "Serverless — no EC2 management", "pros": "No infrastructure, auto-scaling, pay per use", "cons": "No SSH, higher per-unit cost"},
            "EC2": {"description": "Managed instances", "pros": "Lower cost steady-state, SSH access", "cons": "Must manage capacity, patching"},
            "EXTERNAL": {"description": "ECS Anywhere — on-premises", "pros": "Hybrid cloud", "cons": "Self-managed infrastructure"},
        },
        "fargate_cpu_memory": [
            {"cpu": 256, "memory_mb": 512},
            {"cpu": 512, "memory_mb": [1024, 2048]},
            {"cpu": 1024, "memory_mb": [2048, 3072, 4096]},
            {"cpu": 2048, "memory_mb": [4096, 5120, 6144, 7168, 8192]},
            {"cpu": 4096, "memory_mb": [8192, 10240, 12288, 14336, 16384]},
        ],
        "terraform_resource": ["aws_ecs_cluster", "aws_ecs_service", "aws_ecs_task_definition"],
    },

    "eks": {
        "full_name": "Elastic Kubernetes Service",
        "description": "Managed Kubernetes control plane",
        "use_cases": ["Container orchestration at scale", "Multi-container apps", "Service mesh", "CI/CD pipelines", "Machine learning"],
        "key_concepts": ["Cluster", "Node group", "Fargate profile", "Add-ons", "Pod Identity", "OIDC provider", "Helm charts"],
        "kubernetes_versions_supported": ["1.27", "1.28", "1.29", "1.30", "1.31"],
        "node_types": {
            "managed_node_group": "AWS-managed EC2 instances",
            "self_managed": "Self-managed EC2 instances",
            "fargate": "Serverless pods (no EC2)",
        },
        "terraform_resource": ["aws_eks_cluster", "aws_eks_node_group", "aws_eks_fargate_profile"],
    },

    "fargate": {
        "full_name": "AWS Fargate",
        "description": "Serverless compute engine for containers (works with ECS and EKS)",
        "use_cases": ["Containerized apps without server management", "Event-driven containers", "Batch processing"],
        "pricing": "Pay for vCPU and memory per second",
        "compatible_with": ["ECS", "EKS"],
    },

    "batch": {
        "full_name": "AWS Batch",
        "description": "Managed batch computing at any scale",
        "use_cases": ["Scientific simulation", "Financial modeling", "Image/video processing", "ML training", "Genomics"],
        "key_concepts": ["Job queue", "Job definition", "Compute environment", "Job"],
        "compute_options": ["Fargate", "EC2 Spot", "EC2 On-Demand"],
        "terraform_resource": ["aws_batch_job_definition", "aws_batch_job_queue", "aws_batch_compute_environment"],
    },

    "lightsail": {
        "full_name": "Amazon Lightsail",
        "description": "Simplified VPS for simple web apps and dev environments",
        "use_cases": ["Small websites", "Blog platforms", "Dev/test", "Small databases"],
        "plans_start_at": "$3.50/mo (512 MB, 1 vCPU, 20 GB SSD)",
        "features": ["Fixed monthly pricing", "Easy scaling", "Built-in load balancers", "Managed databases"],
    },

    "elastic_beanstalk": {
        "full_name": "AWS Elastic Beanstalk",
        "description": "Platform-as-a-Service for deploying web apps",
        "use_cases": ["Web apps", "API servers", "Worker tiers"],
        "supported_platforms": ["Java", ".NET", "PHP", "Node.js", "Python", "Ruby", "Go", "Docker", "Multi-container Docker"],
        "key_concepts": ["Application", "Environment", "Environment tier", "Platform version"],
    },

    "app_runner": {
        "full_name": "AWS App Runner",
        "description": "Fully managed container application service",
        "use_cases": ["Web apps", "APIs", "Microservices"],
        "source": ["GitHub repository", "Container image (ECR)"],
        "key_concepts": "Auto-scaling, automatic HTTPS, custom domains",
    },

    "outposts": {
        "full_name": "AWS Outposts",
        "description": "AWS infrastructure on-premises",
        "use_cases": ["Low-latency requirements", "Local data processing", "Hybrid cloud"],
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2: AWS STORAGE SERVICES
# ═══════════════════════════════════════════════════════════════════════════════

AWS_STORAGE_SERVICES = {
    "s3": {
        "full_name": "Simple Storage Service",
        "description": "Object storage — virtually unlimited storage for any data type",
        "use_cases": ["Static website hosting", "Backup & restore", "Data lake", "Log storage", "Application assets", "Disaster recovery"],
        "key_concepts": ["Bucket", "Object", "Versioning", "Lifecycle policies", "Encryption", "Access control", "CORS", "Replication"],
        "storage_classes": {
            "S3 Standard": "Frequently accessed data — highest cost, lowest latency",
            "S3 Intelligent-Tiering": "Unknown/changing access patterns — auto-tiering",
            "S3 Standard-IA": "Infrequent access — lower cost, retrieval fee",
            "S3 One Zone-IA": "Infrequent access, single AZ — even lower cost",
            "S3 Glacier Instant Retrieval": "Archive, millisecond retrieval",
            "S3 Glacier Flexible Retrieval": "Archive, minutes to hours retrieval",
            "S3 Glacier Deep Archive": "Long-term archive, 12-48 hours retrieval — cheapest",
        },
        "limits": {
            "max_object_size": "5 TB",
            "max_bucket_size": "Unlimited",
            "max_objects": "Unlimited",
            "max_buckets": "100 (soft limit)",
            "name_rules": "3-63 chars, lowercase, numbers, hyphens, periods",
        },
        "terraform_resource": ["aws_s3_bucket", "aws_s3_bucket_versioning", "aws_s3_bucket_server_side_encryption_configuration", "aws_s3_bucket_public_access_block", "aws_s3_bucket_lifecycle_configuration"],
    },

    "ebs": {
        "full_name": "Elastic Block Store",
        "description": "Persistent block storage for EC2 instances",
        "use_cases": ["Boot volumes", "Database storage", "Enterprise applications"],
        "volume_types": {
            "gp3": {"iops": "3,000-16,000", "throughput": "125-1,000 MB/s", "cost": "$0.08/GB-mo", "bootable": True, "use_case": "Most workloads (default)"},
            "gp2": {"iops": "100-16,000", "throughput": "125-250 MB/s", "cost": "$0.10/GB-mo", "bootable": True, "use_case": "Legacy (gp3 preferred)"},
            "io2 Block Express": {"iops": "256,000", "throughput": "4,000 MB/s", "cost": "$0.125/GB-mo + IOPS", "bootable": True, "use_case": "Mission-critical databases"},
            "io2": {"iops": "100-64,000", "throughput": "1,000 MB/s", "cost": "$0.125/GB-mo + IOPS", "bootable": True, "use_case": "Latency-sensitive apps"},
            "st1": {"iops": "500", "throughput": "500 MB/s", "cost": "$0.045/GB-mo", "bootable": False, "use_case": "Big data, log processing"},
            "sc1": {"iops": "250", "throughput": "250 MB/s", "cost": "$0.015/GB-mo", "bootable": False, "use_case": "Cold storage, infrequent access"},
        },
        "features": ["Snapshots", "Encryption", "Multi-Attach", "Fast Restore", "IOPS Provisioning"],
        "terraform_resource": ["aws_ebs_volume", "aws_ebs_snapshot"],
    },

    "efs": {
        "full_name": "Elastic File System",
        "description": "Managed NFS file system — shared storage for EC2, ECS, EKS",
        "use_cases": ["Shared storage for containers", "CMS content", "Machine learning", "Web serving", "Development tools"],
        "storage_classes": {
            "Standard": "Frequently accessed",
            "Infrequent Access (IA)": "Cost-optimized for less frequent access",
            "Archive": "Long-term storage, rarely accessed",
        },
        "features": ["Auto-scaling", "Multi-AZ", "Encryption", "Performance modes (General Purpose / Max I/O)", "Throughput modes (Bursting / Provisioned / Elastic)"],
        "limits": {"max_size": "Exbibytes", "max_throughput": "3 GiB/s (bursting)"},
        "terraform_resource": ["aws_efs_file_system", "aws_efs_mount_target", "aws_efs_access_point"],
    },

    "fsx": {
        "full_name": "Amazon FSx",
        "description": "Fully managed third-party file systems",
        "options": {
            "FSx for Lustre": {"use_case": "High-performance computing, ML training", "performance": "Tens of GB/s, millions of IOPS"},
            "FSx for Windows File Server": {"use_case": "Windows workloads, Active Directory", "protocol": "SMB"},
            "FSx for NetApp ONTAP": {"use_case": "Enterprise NAS workloads", "features": "NFS, SMB, iSCSI, snapshots, cloning"},
            "FSx for OpenZFS": {"use_case": "Linux/NFS workloads, data compression", "features": "Snapshots, clones, compression"},
        },
        "terraform_resource": ["aws_fsx_lustre_file_system", "aws_fsx_windows_file_system"],
    },

    "storage_gateway": {
        "full_name": "AWS Storage Gateway",
        "description": "Hybrid cloud storage — connects on-prem to AWS",
        "types": {
            "File Gateway": "NFS/SMB access to S3",
            "Volume Gateway": "iSCSI block storage backed by S3",
            "Tape Gateway": "Virtual tape library for backup",
        },
    },

    "snowball": {
        "full_name": "AWS Snow Family",
        "description": "Physical data transport for large-scale data migration",
        "options": {
            "Snowcone": "8 TB - smallest, ruggedized",
            "Snowball Edge Compute Optimized": "42 TB, GPU available",
            "Snowball Edge Storage Optimized": "80 TB, high storage",
            "Snowmobile": "100 PB — truck-scale migration",
        },
        "use_cases": ["Large data migration", "Edge computing", "Disconnected environments"],
    },

    "backup": {
        "full_name": "AWS Backup",
        "description": "Centralized backup service across AWS services",
        "supported_services": ["EBS", "EC2", "EFS", "FSx", "RDS", "DynamoDB", "Storage Gateway", "CloudWatch Logs"],
        "features": ["Centralized management", "Automated scheduling", "Cross-region backup", "Cross-account backup", "Lifecycle management", "Restore testing"],
        "terraform_resource": "aws_backup_vault",
    },

    "elastic_disaster_recovery": {
        "full_name": "AWS Elastic Disaster Recovery (DRS)",
        "description": "Continuous replication for disaster recovery",
        "use_cases": ["Disaster recovery", "Cloud migration", "Dev/Test from production"],
        "rpo": "Seconds", "rto": "Minutes",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3: AWS DATABASE SERVICES
# ═══════════════════════════════════════════════════════════════════════════════

AWS_DATABASE_SERVICES = {
    "rds": {
        "full_name": "Relational Database Service",
        "description": "Managed relational databases (MySQL, PostgreSQL, etc.)",
        "engines": {
            "MySQL": {"versions": ["8.0", "8.4"], "port": 3306},
            "PostgreSQL": {"versions": ["14", "15", "16", "17"], "port": 5432},
            "MariaDB": {"versions": ["10.6", "10.11"], "port": 3306},
            "Microsoft SQL Server": {"versions": ["2019", "2022"], "port": 1433},
            "Oracle": {"versions": ["19c", "21c"], "port": 1521},
        },
        "instance_classes": {
            "db.t3.micro": "Free tier, dev/test (2 vCPU, 1 GB)",
            "db.t3.small": "Small apps (2 vCPU, 2 GB)",
            "db.t3.medium": "Medium apps (2 vCPU, 4 GB)",
            "db.r5.large": "Production (2 vCPU, 16 GB)",
            "db.r5.xlarge": "Large production (4 vCPU, 32 GB)",
            "db.r6g.large": "Graviton (2 vCPU, 16 GB, better price/perf)",
        },
        "features": ["Multi-AZ", "Read Replicas", "Automated backups", "Encryption at rest", "Performance Insights", "IAM authentication", "Proxy"],
        "storage": {"type": "gp3 or io1", "max": "64 TB", "autoscaling": True},
        "terraform_resource": ["aws_db_instance", "aws_db_cluster"],
    },

    "aurora": {
        "full_name": "Amazon Aurora",
        "description": "Cloud-native relational database (MySQL/PostgreSQL compatible)",
        "performance": "5x MySQL, 3x PostgreSQL throughput",
        "features": ["Up to 15 read replicas", "Global Database", "Serverless v2", "Backtrack", "Parallel query", "ML integration"],
        "storage": {"type": "Distributed SSD", "auto_scales": "Up to 128 TB", "replication": "6 copies across 3 AZs"},
        "serverless_v2": {"min_acu": 0.5, "max_acu": 128, "use_case": "Variable/unpredictable workloads"},
        "terraform_resource": ["aws_rds_cluster", "aws_rds_cluster_instance"],
    },

    "dynamodb": {
        "full_name": "Amazon DynamoDB",
        "description": "Serverless NoSQL key-value and document database",
        "use_cases": ["Gaming leaderboards", "Session stores", "IoT data", "Shopping carts", "Real-time bidding", "Social networks"],
        "capacity_modes": {
            "on_demand": "Pay per request, no capacity planning",
            "provisioned": "Set read/write capacity, can auto-scale",
        },
        "features": ["Global tables (multi-region)", "Point-in-time recovery", "DynamoDB Streams", "DAX (in-memory cache)", "PartiQL", "Export to S3", "Global Secondary Indexes", "Local Secondary Indexes"],
        "limits": {"item_size": "400 KB", "partition_key": "2048 bytes", "sort_key": "1024 bytes"},
        "terraform_resource": "aws_dynamodb_table",
    },

    "elasticache": {
        "full_name": "Amazon ElastiCache",
        "description": "Managed in-memory caching (Redis and Memcached)",
        "engines": {
            "Redis": {"features": "Persistence, replication, Lua scripting, pub/sub, streams", "use_case": "Session store, leaderboard, real-time analytics, message broker"},
            "Memcached": {"features": "Simple caching, multi-threaded", "use_case": "Simple caching, database query caching"},
        },
        "node_types": ["cache.t3.micro", "cache.t3.small", "cache.t3.medium", "cache.r6g.large", "cache.r6g.xlarge"],
        "features": ["Multi-AZ", "Auto failover (Redis)", "Encryption at rest/transit", "Backup/restore"],
        "terraform_resource": ["aws_elasticache_cluster", "aws_elasticache_replication_group"],
    },

    "memorydb": {
        "full_name": "Amazon MemoryDB for Redis",
        "description": "Redis-compatible, durable in-memory database",
        "use_case": "Microservices, caching, messaging — with durability",
        "difference_from_elasticache": "MemoryDB = primary database with durability; ElastiCache = caching layer",
    },

    "redshift": {
        "full_name": "Amazon Redshift",
        "description": "Data warehouse for analytics at petabyte scale",
        "use_cases": ["Business intelligence", "Reporting", "Data lake analytics", "ML on data warehouse"],
        "features": ["Serverless", "Concurrency scaling", "Spectrum (query S3 directly)", "ML integration", "Materialized views"],
        "instance_types": ["ra3.xlplus", "ra3.2xlarge", "ra3.4xlarge", "ra3.16xlarge"],
        "terraform_resource": "aws_redshift_cluster",
    },

    "documentdb": {
        "full_name": "Amazon DocumentDB",
        "description": "MongoDB-compatible managed document database",
        "compatible_with": "MongoDB 4.0, 5.0, 6.0, 7.0 API",
        "use_case": "Content management, catalog, user profiles",
    },

    "neptune": {
        "full_name": "Amazon Neptune",
        "description": "Managed graph database (Gremlin and SPARQL)",
        "use_cases": ["Social networks", "Knowledge graphs", "Fraud detection", "Recommendation engines", "Identity graphs"],
    },

    "timestream": {
        "full_name": "Amazon Timestream",
        "description": "Serverless time-series database",
        "use_cases": ["IoT telemetry", "DevOps monitoring", "Application metrics", "Clickstream data"],
        "features": ["Auto-scaling", "Built-in time-series functions", "Scheduled queries", "Memory store + magnetic store"],
    },

    "keyspaces": {
        "full_name": "Amazon Keyspaces (for Apache Cassandra)",
        "description": "Managed Cassandra-compatible database",
        "use_case": "Existing Cassandra workloads migrating to cloud",
    },

    "qldb": {
        "full_name": "Amazon QLDB",
        "description": "Quantum Ledger Database — immutable transaction log",
        "use_cases": ["Banking transactions", "Supply chain", "Insurance claims", "Registration records"],
    },

    "dax": {
        "full_name": "Amazon DynamoDB Accelerator",
        "description": "In-memory caching layer for DynamoDB",
        "performance": "Microsecond read latency (10x faster)",
    },

    "neptune_ml": {
        "full_name": "Neptune ML",
        "description": "ML on graph data using Gremlin",
        "use_case": "Predictions on graph data (fraud, recommendations)",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4: AWS NETWORKING & CONTENT DELIVERY
# ═══════════════════════════════════════════════════════════════════════════════

AWS_NETWORKING_SERVICES = {
    "vpc": {
        "full_name": "Virtual Private Cloud",
        "description": "Isolated virtual network for your AWS resources",
        "key_concepts": ["Subnets", "Route tables", "Internet Gateway", "NAT Gateway", "VPC Peering", "Endpoints", "Flow Logs"],
        "cidr_ranges": ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
        "max_cidr_size": "/16 (65,536 IPs)",
        "min_cidr_size": "/28 (16 IPs)",
        "best_practices": ["Use multiple AZs", "Private subnets for databases", "NAT Gateway for private outbound", "VPC endpoints for AWS services", "Flow logs for auditing"],
        "terraform_resource": ["aws_vpc", "aws_subnet", "aws_route_table", "aws_internet_gateway", "aws_nat_gateway"],
    },

    "route53": {
        "full_name": "Amazon Route 53",
        "description": "DNS web service and domain registration",
        "routing_policies": {
            "simple": "Single resource",
            "weighted": "Distribute traffic by weight",
            "latency": "Lowest latency routing",
            "failover": "Active-passive failover",
            "geolocation": "Based on user location",
            "geoproximity": "Based on resource location + bias",
            "multivalue": "Return multiple healthy records",
            "ip_based": "Based on client IP",
        },
        "health_checks": "Monitors endpoint health, triggers failover",
        "features": ["Domain registration", "DNS routing", "Health checking", "Traffic flow (visual editor)", "Resolver (hybrid DNS)"],
        "terraform_resource": ["aws_route53_zone", "aws_route53_record", "aws_route53_health_check"],
    },

    "cloudfront": {
        "full_name": "Amazon CloudFront",
        "description": "Content Delivery Network (CDN) — edge locations for fast delivery",
        "use_cases": ["Static/dynamic content", "API acceleration", "Live/on-demand streaming", "DDoS protection (with Shield)"],
        "origins": ["S3 bucket", "ALB", "NLB", "EC2", "Any HTTP backend"],
        "features": ["200+ edge locations", "Lambda@Edge", "CloudFront Functions", "Field-level encryption", "Origin access control", "Real-time logs", "Security (WAF integration)"],
        "price_classes": ["PriceClass_All", "PriceClass_200", "PriceClass_100"],
        "terraform_resource": "aws_cloudfront_distribution",
    },

    "alb": {
        "full_name": "Application Load Balancer",
        "description": "Layer 7 load balancer — HTTP/HTTPS routing",
        "use_cases": ["Web applications", "Microservices", "Containerized apps (ECS/EKS)", "HTTP APIs"],
        "features": ["Path-based routing", "Host-based routing", "HTTP/HTTPS", "WebSocket", "gRPC", "Lambda targets", "WAF integration", "Access logs", "Deletion protection"],
        "health_checks": "HTTP/HTTPS based, configurable path, interval, thresholds",
        "terraform_resource": ["aws_lb", "aws_lb_target_group", "aws_lb_listener"],
    },

    "nlb": {
        "full_name": "Network Load Balancer",
        "description": "Layer 4 load balancer — ultra-high performance, low latency",
        "use_cases": ["Extreme performance", "Static IP", "TLS offloading", "IoT", "Gaming", "Financial apps"],
        "features": ["Millions of requests/sec", "Ultra-low latency (single-digit ms)", "Static IP", "Cross-zone load balancing", "TCP/UDP/TLS"],
        "terraform_resource": ["aws_lb", "aws_lb_target_group"],
    },

    "glb": {
        "full_name": "Gateway Load Balancer",
        "description": "Layer 3 load balancer — deploy and manage virtual appliances",
        "use_cases": ["Firewalls", "Intrusion detection", "Deep packet inspection", "Network virtual appliances"],
        "protocol": "GENEVE",
    },

    "vpc_lattice": {
        "full_name": "Amazon VPC Lattice",
        "description": "Application-layer networking for services",
        "use_cases": ["Service-to-service communication", "Cross-VPC connectivity", "Cross-account networking"],
        "features": ["Service discovery", "Load balancing", "Auth policies", "Access logs"],
    },

    "transit_gateway": {
        "full_name": "AWS Transit Gateway",
        "description": "Hub-and-spoke network connecting VPCs and on-premises",
        "use_cases": ["Connect multiple VPCs", "Hybrid cloud", "Simplified networking"],
        "features": ["Up to 5,000 VPC attachments", "VPN connections", "Direct Connect", "Multicast"],
        "terraform_resource": "aws_ec2_transit_gateway",
    },

    "direct_connect": {
        "full_name": "AWS Direct Connect",
        "description": "Dedicated network connection from on-premises to AWS",
        "speeds": ["50 Mbps", "100 Mbps", "200 Mbps", "300 Mbps", "400 Mbps", "500 Mbps", "1 Gbps", "2 Gbps", "5 Gbps", "10 Gbps"],
        "use_case": "Consistent bandwidth, lower latency, hybrid cloud",
    },

    "global_accelerator": {
        "full_name": "AWS Global Accelerator",
        "description": "Route traffic through AWS global network for better performance",
        "use_cases": ["Global applications", "Gaming", "IoT", "Static IP addresses"],
        "features": ["Two static Anycast IPs", "AWS global backbone", "Health checks", "Failover in <30s"],
    },

    "api_gateway": {
        "full_name": "Amazon API Gateway",
        "description": "Create, publish, and manage APIs at any scale",
        "types": {
            "REST API": "Full-featured, caching, request/response transformation",
            "HTTP API": "Lightweight, lower cost, faster",
            "WebSocket API": "Real-time bidirectional communication",
        },
        "features": ["Throttling", "API keys", "Usage plans", "WAF integration", "Custom domains", "Caching", "Request validation", "CloudWatch logging"],
        "terraform_resource": "aws_api_gateway_rest_api",
    },

    "global_acCELERATOR": "See global_accelerator above",

    "elastic_ip": {
        "full_name": "Elastic IP Address",
        "description": "Static public IPv4 address for dynamic cloud computing",
        "use_case": "Failover, remapping to another instance",
        "cost": "$0.005/hr when not in use — always allocate when needed",
    },

    "ipv6": {
        "full_name": "IPv6 on VPC",
        "description": "Dual-stack networking for VPC",
        "use_case": "Public-facing resources, compliance",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 5: AWS SECURITY, IDENTITY & COMPLIANCE
# ═══════════════════════════════════════════════════════════════════════════════

AWS_SECURITY_SERVICES = {
    "iam": {
        "full_name": "Identity and Access Management",
        "description": "Manage access to AWS resources",
        "key_concepts": ["Users", "Groups", "Roles", "Policies", "Permissions boundaries", "Conditions", "ARNs"],
        "policy_types": {
            "identity_based": "Attached to users/groups/roles — allow/deny",
            "resource_based": "Attached to resources — who can access",
            "permission_boundary": "Maximum permissions for IAM entities",
            "service_control_policies": "Organization-level permission guardrails",
            "session_policies": "Inline policies for temporary credentials",
        },
        "best_practices": ["Least privilege", "Use roles over users", "Enable MFA", "Rotate credentials", "Use conditions", "CloudTrail for auditing"],
        "arn_format": "arn:aws:service:region:account:resource",
        "terraform_resource": ["aws_iam_user", "aws_iam_role", "aws_iam_policy", "aws_iam_group"],
    },

    "cognito": {
        "full_name": "Amazon Cognito",
        "description": "User authentication and authorization for web/mobile apps",
        "components": {
            "User Pools": "Sign-up and sign-in (user directory)",
            "Identity Pools": "Temporary AWS credentials",
        },
        "features": ["Social sign-in (Google, Facebook, Apple)", "SAML/OIDC federation", "MFA", "Custom auth flows", "Progressive enrollment"],
    },

    "kms": {
        "full_name": "Key Management Service",
        "description": "Managed encryption keys",
        "use_cases": ["Encrypt data at rest", "Encrypt secrets", "Envelope encryption", "Signed URLs (S3)"],
        "key_types": {
            "customer_managed": "You control rotation, policies, deletion",
            "aws_managed": "AWS manages, free for service integration",
        },
        "features": ["Automatic rotation", "Key policies", "Grants", "Aliases", "Multi-region keys"],
        "terraform_resource": "aws_kms_key",
    },

    "secrets_manager": {
        "full_name": "AWS Secrets Manager",
        "description": "Manage secrets (passwords, API keys, certificates)",
        "use_cases": ["Database credentials", "API keys", "OAuth tokens", "SSH keys"],
        "features": ["Automatic rotation (Lambda)", "Cross-account access", "Encrypted at rest", "Audit with CloudTrail", "Version management"],
        "terraform_resource": "aws_secretsmanager_secret",
    },

    "ssm_parameter_store": {
        "full_name": "AWS Systems Manager Parameter Store",
        "description": "Hierarchical configuration data and secrets management",
        "types": {
            "String": "Plain text parameters",
            "StringList": "Comma-separated values",
            "SecureString": "Encrypted with KMS",
        },
        "features": ["Hierarchy", "Versioning", "Policies", "Cross-account sharing"],
        "terraform_resource": "aws_ssm_parameter",
    },

    "waf": {
        "full_name": "AWS WAF",
        "description": "Web Application Firewall — protect against web exploits",
        "use_cases": ["SQL injection", "XSS", "Rate limiting", "Geographic blocking", "Bot control"],
        "managed_rule_groups": ["AWS Managed Rules", "AWS Marketplace", "Custom"],
        "integration": ["CloudFront", "ALB", "API Gateway", "AppSync"],
        "terraform_resource": "aws_wafv2_web_acl",
    },

    "shield": {
        "full_name": "AWS Shield",
        "description": "DDoS protection",
        "tiers": {
            "Standard": "Free — automatic protection against most common DDoS attacks",
            "Advanced": "Paid — 24/7 DDoS Response Team, cost protection, advanced diagnostics",
        },
    },

    "guardduty": {
        "full_name": "Amazon GuardDuty",
        "description": "Threat detection using ML",
        "monitors": ["CloudTrail", "VPC Flow Logs", "DNS logs", "EKS audit logs", "S3 data events", "RDS login events"],
        "features": ["ML-powered", "Continuous monitoring", "Automated responses"],
    },

    "macie": {
        "full_name": "Amazon Macie",
        "description": "Discover and protect sensitive data in S3",
        "detects": ["PII", "PHI", "Financial data", "Credentials"],
    },

    "detective": {
        "full_name": "Amazon Detective",
        "description": "Security investigation using graph analysis",
        "use_case": "Investigate security findings quickly",
    },

    "security_hub": {
        "full_name": "AWS Security Hub",
        "description": "Central security findings dashboard",
        "integrations": "GuardDuty, Inspector, Macie, IAM Access Analyzer, Firewall Manager, third-party",
        "standards": ["AWS Foundational Security", "CIS Benchmarks", "PCI DSS", "NIST"],
    },

    "inspector": {
        "full_name": "Amazon Inspector",
        "description": "Automated vulnerability scanning",
        "scans": ["EC2 instances", "ECR container images", "Lambda functions"],
    },

    "firewall_manager": {
        "full_name": "AWS Firewall Manager",
        "description": "Central security management across accounts",
        "use_case": "Multi-account security policies (WAF, Shield, Security Groups, VPC, etc.)",
    },

    "iam_access_analyzer": {
        "full_name": "IAM Access Analyzer",
        "description": "Identify resources shared with external entities",
        "use_case": "Find overly permissive policies, cross-account access",
    },

    "certificate_manager": {
        "full_name": "AWS Certificate Manager (ACM)",
        "description": "Provision and manage SSL/TLS certificates",
        "features": ["Free public certificates", "Auto-renewal", "Import private certificates", "Integration with ALB, CloudFront, API Gateway"],
        "terraform_resource": "aws_acm_certificate",
    },

    "resource_access_manager": {
        "full_name": "AWS Resource Access Manager (RAM)",
        "description": "Share resources across AWS accounts",
        "shareable": ["VPC Subnets", "Transit Gateway", "License Manager", "Route53 Resolver rules"],
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 6: AWS MANAGEMENT & GOVERNANCE
# ═══════════════════════════════════════════════════════════════════════════════

AWS_MANAGEMENT_SERVICES = {
    "cloudwatch": {
        "full_name": "Amazon CloudWatch",
        "description": "Monitoring, observability, and operational excellence",
        "features": ["Metrics", "Alarms", "Logs", "Dashboards", "Anomaly Detection", "Synthetics", "Contributor Insights", "ServiceLens", "Evidently", "Real User Monitoring"],
        "use_cases": ["Performance monitoring", "Cost optimization", "Security auditing", "Automation"],
        "log_groups": "Organize logs by function/service",
        "retention": "Never expire, 1 day to 10 years",
        "terraform_resource": ["aws_cloudwatch_metric_alarm", "aws_cloudwatch_log_group", "aws_cloudwatch_dashboard"],
    },

    "cloudtrail": {
        "full_name": "AWS CloudTrail",
        "description": "Audit API activity across your AWS account",
        "features": ["Event history (90 days)", "Trails (continuous to S3)", "Insights", "Integration with CloudWatch Logs"],
        "use_cases": ["Compliance auditing", "Security analysis", "Resource change tracking"],
    },

    "cloudformation": {
        "full_name": "AWS CloudFormation",
        "description": "Infrastructure as Code using JSON/YAML templates",
        "vs_terraform": "CloudFormation = AWS-native, declarative; Terraform = Multi-cloud, imperative + declarative",
        "features": ["Change sets", "Stack policies", "Drift detection", "Stack sets (multi-account)", "Custom resources", "Imports"],
        "template_format": "JSON or YAML",
    },

    "systems_manager": {
        "full_name": "AWS Systems Manager",
        "description": "Operational management for AWS resources",
        "features": {
            "Parameter Store": "Configuration data and secrets",
            "Session Manager": "Shell access without SSH/bastion",
            "Patch Manager": "Automated patching",
            "State Manager": "Configuration compliance",
            "Run Command": "Remote command execution",
            "Automation": "Automated operational tasks",
            "OpsCenter": "Operational issues",
            "Incident Manager": "Incident response",
            "Change Manager": "Change requests",
        },
    },

    "config": {
        "full_name": "AWS Config",
        "description": "Track resource configuration changes",
        "features": ["Resource inventory", "Change history", "Compliance auditing", "Configuration analysis"],
        "use_case": "Compliance monitoring, security auditing",
    },

    "control_tower": {
        "full_name": "AWS Control Tower",
        "description": "Set up and govern multi-account environments",
        "features": ["Landing zone", "Guardrails", "Account factory", "Compliance dashboard"],
    },

    "organizations": {
        "full_name": "AWS Organizations",
        "description": "Manage multiple AWS accounts",
        "features": ["Consolidated billing", "Service Control Policies", "Resource sharing", "Tag policies"],
    },

    "cost_explorer": {
        "full_name": "AWS Cost Explorer",
        "description": "Visualize and manage AWS costs",
        "features": ["Cost forecasting", "Budgets", "Cost allocation tags", "Reserved instance recommendations", "Savings Plans recommendations"],
    },

    "budgets": {
        "full_name": "AWS Budgets",
        "description": "Set custom cost and usage budgets",
        "budget_types": ["Cost budgets", "Usage budgets", "Reservation budgets", "Savings Plans budgets"],
        "alerts": ["Actual", "Forecasted"],
    },

    "trusted_advisor": {
        "full_name": "AWS Trusted Advisor",
        "description": "Best practice checks across your account",
        "categories": ["Cost optimization", "Performance", "Security", "Fault tolerance", "Service limits"],
    },

    "compute_optimizer": {
        "full_name": "AWS Compute Optimizer",
        "description": "Right-size resources using ML",
        "monitors": ["EC2", "EBS", "Lambda", "Auto Scaling groups", "ECS services on Fargate"],
    },

    "license_manager": {
        "full_name": "AWS License Manager",
        "description": "Manage software licenses",
    },

    "backup": {
        "full_name": "AWS Backup",
        "description": "Centralized backup across AWS services",
        "supported": ["EC2", "EBS", "EFS", "FSx", "RDS", "Aurora", "DynamoDB", "Storage Gateway", "CloudWatch Logs"],
    },

    "x_ray": {
        "full_name": "AWS X-Ray",
        "description": "Distributed tracing for microservices",
        "features": ["Service map", "Traces", "Insights", "Groups", "Annotations and metadata"],
        "use_case": "Debugging and performance analysis",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 7: AWS DEVOPS & DEVELOPER TOOLS
# ═══════════════════════════════════════════════════════════════════════════════

AWS_DEVOPS_SERVICES = {
    "codecommit": {
        "full_name": "AWS CodeCommit",
        "description": "Managed Git repositories",
        "features": ["HTTPS/SSH cloning", "Branch permissions", "Pull requests", "Code review", "Triggers"],
    },

    "codebuild": {
        "full_name": "AWS CodeBuild",
        "description": "Managed build service",
        "use_cases": ["Compile source", "Run tests", "Produce artifacts", "Security scans"],
        "environments": ["Docker", "Managed image", "Custom"],
        "build_spec": "YAML build specification",
        "terraform_resource": "aws_codebuild_project",
    },

    "codedeploy": {
        "full_name": "AWS CodeDeploy",
        "description": "Automated deployments",
        "deployment_groups": {
            "ec2": "In-place deployment on EC2",
            "lambda": "Lambda function deployment",
            "ecs": "ECS Blue/Green deployment",
        },
        "strategies": ["AllAtOnce", "Linear", "Canary", "BlueGreen"],
        "terraform_resource": "aws_codedeploy_app",
    },

    "codepipeline": {
        "full_name": "AWS CodePipeline",
        "description": "CI/CD pipeline orchestration",
        "stages": ["Source", "Build", "Test", "Deploy"],
        "integrations": ["CodeCommit", "CodeBuild", "CodeDeploy", "GitHub", "Jenkins", "S3", "ECS", "CloudFormation"],
        "terraform_resource": "aws_codepipeline",
    },

    "codeguru": {
        "full_name": "Amazon CodeGuru",
        "description": "ML-powered code reviews and profiling",
        "components": {
            "Reviewer": "Automated code reviews",
            "Profiler": "Application performance profiling",
        },
    },

    "devops_guru": {
        "full_name": "Amazon DevOps Guru",
        "description": "ML-powered operational recommendations",
        "monitors": ["CloudTrail", "CloudWatch", "VPC Flow Logs", "X-Ray", "Config", "Lambda", "RDS", "DynamoDB", "S3", "ECS"],
    },

    "copilot": {
        "full_name": "AWS Copilot CLI",
        "description": "CLI to build and manage containerized applications on ECS/Fargate",
        "features": ["Service scaffolding", "Environment management", "Pipeline creation", "Storage configuration"],
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 8: AWS APPLICATION INTEGRATION
# ═══════════════════════════════════════════════════════════════════════════════

AWS_APPLICATION_INTEGRATION = {
    "sqs": {
        "full_name": "Amazon Simple Queue Service",
        "description": "Fully managed message queuing",
        "types": {
            "standard": "At-least-once delivery, best-effort ordering",
            "fifo": "Exactly-once processing, strict ordering",
        },
        "features": ["Dead letter queues", "Delay queues", "Message retention", "Long polling", "Encryption", "Access policy"],
        "max_message_size": "256 KB",
        "use_case": "Decouple microservices, buffer writes, fan-out",
        "terraform_resource": "aws_sqs_queue",
    },

    "sns": {
        "full_name": "Amazon Simple Notification Service",
        "description": "Pub/sub messaging and mobile notifications",
        "protocols": ["HTTP/HTTPS", "Email", "SMS", "SQS", "Lambda", "Firehose", "Application"],
        "features": ["Message filtering", "Message retention", "Encryption", "Delivery status logging", "Fan-out"],
        "use_case": "Event notifications, alerting, fan-out to multiple subscribers",
        "terraform_resource": "aws_sns_topic",
    },

    "eventbridge": {
        "full_name": "Amazon EventBridge",
        "description": "Serverless event bus for application integration",
        "use_cases": ["Event-driven architectures", "SaaS integrations", "Workflow orchestration", "Scheduled events"],
        "features": ["Event rules", "Targets (20+ services)", "Schema registry", "Event replay", "Cross-account events", "Partner event sources"],
        "terraform_resource": "aws_cloudwatch_event_rule",
    },

    "step_functions": {
        "full_name": "AWS Step Functions",
        "description": "Serverless workflow orchestration",
        "types": {
            "standard": "Long-running, auditable workflows",
            "express": "High-volume, event-processing workflows",
        },
        "states": ["Task", "Choice", "Wait", "Pass", "Fail", "Succeed", "Map", "Parallel"],
        "use_cases": ["Multi-step processes", "Error handling", "Approval workflows", "Machine learning pipelines", "ETL"],
        "terraform_resource": "aws_sfn_state_machine",
    },

    "mq": {
        "full_name": "Amazon MQ",
        "description": "Managed message broker (ActiveMQ and RabbitMQ)",
        "use_case": "Lift-and-shift existing message broker workloads",
    },

    "msk": {
        "full_name": "Amazon Managed Streaming for Kafka",
        "description": "Managed Apache Kafka",
        "use_cases": ["Event streaming", "Log aggregation", "Stream processing"],
        "features": ["Auto-scaling", "Encryption", "Multi-AZ", "Monitoring"],
    },

    "kinesis_data_streams": {
        "full_name": "Amazon Kinesis Data Streams",
        "description": "Real-time data streaming",
        "use_cases": ["Real-time analytics", "Log processing", "IoT data ingestion", "Event sourcing"],
    },

    "kinesis_data_firehose": {
        "full_name": "Amazon Kinesis Data Firehose",
        "description": "Streaming data delivery to destinations",
        "destinations": ["S3", "Redshift", "Elasticsearch", "Splunk", "HTTP endpoints", "Datadog", "Dynatrace"],
    },

    "appsync": {
        "full_name": "AWS AppSync",
        "description": "Managed GraphQL service",
        "features": ["Real-time subscriptions", "Data source integrations", "Offline data sync", "Fine-grained access control"],
    },

    "amazon_mq": "See MQ above",
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 9: AWS ANALYTICS
# ═══════════════════════════════════════════════════════════════════════════════

AWS_ANALYTICS_SERVICES = {
    "athena": {
        "full_name": "Amazon Athena",
        "description": "Serverless interactive query service for S3 data",
        "query_language": "Standard SQL",
        "use_cases": ["Ad-hoc querying", "Log analysis", "Data lake analytics"],
        "formats": ["Parquet", "ORC", "JSON", "CSV", "Avro"],
        "features": ["Pay per query", "Workgroups", "Named queries", "Saved queries", "Athena Workgroups"],
        "terraform_resource": "aws_athena_workgroup",
    },

    "glue": {
        "full_name": "AWS Glue",
        "description": "Serverless data integration (ETL)",
        "features": ["Data catalog", "ETL jobs (PySpark)", "Visual editor", "Streaming ETL", "DataBrew", "Studio"],
        "use_cases": ["ETL pipelines", "Data catalog", "Data preparation", "Schema management"],
    },

    "emr": {
        "full_name": "Amazon EMR",
        "description": "Managed big data platforms (Hadoop, Spark, Hive, etc.)",
        "frameworks": ["Apache Spark", "Apache Hive", "Apache HBase", "Presto", "Trino"],
        "use_cases": ["Big data processing", "Machine learning", "ETL", "Interactive SQL"],
        "instance_types": ["EC2", "EKS"],
    },

    "kinesis_data_analytics": {
        "full_name": "Amazon Kinesis Data Analytics",
        "description": "SQL/Python analytics on streaming data",
        "use_case": "Real-time analytics on streaming data",
    },

    "opensearch": {
        "full_name": "Amazon OpenSearch Service",
        "description": "Managed Elasticsearch/OpenSearch for search and analytics",
        "use_cases": ["Log analytics", "Full-text search", "Application monitoring", "Security analytics"],
        "features": ["Dashboards (Kibana)", "Machine learning", "Alerting", "Index State Management"],
        "terraform_resource": "aws_opensearch_domain",
    },

    "lake_formation": {
        "full_name": "AWS Lake Formation",
        "description": "Build and manage data lakes",
        "features": ["Fine-grained access control", "Data sharing", "Blueprints", "Permissions management"],
    },

    "quick_sight": {
        "full_name": "Amazon QuickSight",
        "description": "Serverless BI dashboards and visualizations",
        "features": ["SPICE (in-memory engine)", "Embedded dashboards", "ML insights", "Natural language queries (Q)"],
    },

    "kinesis_data_stream": "See kinesis_data_streams above",

    "managed_grafana": {
        "full_name": "Amazon Managed Grafana",
        "description": "Managed Grafana for operational dashboards",
        "data_sources": ["CloudWatch", "Prometheus", "X-Ray", "OpenSearch", "IoT", "AWS X-Ray"],
    },

    "managed_prometheus": {
        "full_name": "Amazon Managed Service for Prometheus",
        "description": "Serverless Prometheus-compatible monitoring",
        "use_case": "Container and microservices monitoring",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 10: AWS MACHINE LEARNING
# ═══════════════════════════════════════════════════════════════════════════════

AWS_ML_SERVICES = {
    "sagemaker": {
        "full_name": "Amazon SageMaker",
        "description": "Build, train, and deploy ML models",
        "features": ["Notebooks", "Training jobs", "Model deployment", "Endpoints", "Autopilot", "Pipelines", "Feature Store", "Model Registry"],
        "instance_types": ["ml.t3.medium", "ml.g4dn.xlarge", "ml.p3.2xlarge", "ml.p4d.24xlarge"],
    },

    "bedrock": {
        "full_name": "Amazon Bedrock",
        "description": "Foundation models as a service",
        "models": ["Claude", "Titan", "Llama", "Stable Diffusion", "Jurassic"],
        "features": ["Knowledge bases", "Agents", "Guardrails", "Custom model fine-tuning", "Provisioned throughput"],
    },

    "comprehend": {
        "full_name": "Amazon Comprehend",
        "description": "NLP — sentiment analysis, entity recognition, etc.",
    },

    "lex": {
        "full_name": "Amazon Lex",
        "description": "Chatbot and voice assistant builder",
        "powers": "Alexa",
    },

    "polly": {
        "full_name": "Amazon Polly",
        "description": "Text-to-speech",
    },

    "rekognition": {
        "full_name": "Amazon Rekognition",
        "description": "Image and video analysis",
        "features": ["Object detection", "Face recognition", "Text extraction", "Content moderation", "Celebrity recognition"],
    },

    "textract": {
        "full_name": "Amazon Textract",
        "description": "Extract text and data from documents",
    },

    "translate": {
        "full_name": "Amazon Translate",
        "description": "Neural machine translation",
    },

    "transcribe": {
        "full_name": "Amazon Transcribe",
        "description": "Speech-to-text",
    },

    "forecast": {
        "full_name": "Amazon Forecast",
        "description": "Time-series forecasting",
    },

    "personalize": {
        "full_name": "Amazon Personalize",
        "description": "Real-time personalized recommendations",
    },

    "lookout": {
        "full_name": "Amazon Lookout",
        "components": {
            "Lookout for Metrics": "Automated anomaly detection",
            "Lookout for Vision": "Visual inspection",
            "Lookout for Equipment": "Predictive maintenance",
        },
    },

    "sagemaker_canvas": {
        "full_name": "SageMaker Canvas",
        "description": "No-code ML for business analysts",
    },

    "sagemaker_studio": {
        "full_name": "SageMaker Studio",
        "description": "IDE for ML development",
    },

    "timestream_for_liveanalytics": "See timestream in database section",

    "neura_studio": {
        "full_name": "AWS Neuron",
        "description": "ML on Trainium and Inferentia chips",
        "use_case": "Cost-effective ML training and inference",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 11: AWS CONTAINER SERVICES
# ═══════════════════════════════════════════════════════════════════════════════

AWS_CONTAINER_SERVICES = {
    "ecr": {
        "full_name": "Elastic Container Registry",
        "description": "Managed Docker container registry",
        "use_cases": ["Store Docker images", "CI/CD integration", "Image scanning", "Cross-account sharing"],
        "features": ["Image scanning (vulnerabilities)", "Lifecycle policies", "Cross-region replication", "Image signing", "Pull-through cache"],
        "image_types": ["private", "public"],
        "terraform_resource": ["aws_ecr_repository", "aws_ecr_lifecycle_policy"],
    },

    "ecs": "See ECS in Compute section",

    "eks": "See EKS in Compute section",

    "fargate": "See Fargate in Compute section",

    "service_connect": {
        "full_name": "Amazon ECS Service Connect",
        "description": "Service discovery and communication for ECS",
        "features": ["DNS-based discovery", "Load balancing", "Traffic management", "Retry policies"],
    },

    "service_discovery": {
        "full_name": "AWS Cloud Map",
        "description": "Service discovery for ECS, EKS, and EC2",
        "use_case": "DNS-based service discovery",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 12: AWS MIGRATION & TRANSFER
# ═══════════════════════════════════════════════════════════════════════════════

AWS_MIGRATION_SERVICES = {
    "dms": {
        "full_name": "Database Migration Service",
        "description": "Migrate databases to AWS",
        "use_cases": ["Homogeneous migration (MySQL→MySQL)", "Heterogeneous (Oracle→Aurora)", "Continuous replication"],
        "features": ["Full load", "CDC (Change Data Capture)", "Schema conversion tool"],
    },

    "sms": {
        "full_name": "Server Migration Service",
        "description": "Migrate on-premises servers to AWS",
    },

    "application_migration_service": {
        "full_name": "AWS Application Migration Service (MGN)",
        "description": "Lift-and-shift migration",
        "replaces": "SMS (Server Migration Service)",
    },

    "datasync": {
        "full_name": "AWS DataSync",
        "description": "Automated data transfer between on-prem and AWS",
        "use_cases": ["Large-scale data transfer", "Data lake ingestion", "Backup migration"],
    },

    "transfer_family": {
        "full_name": "AWS Transfer Family",
        "description": "SFTP, FTPS, FTP for S3 and EFS",
    },

    "snow_family": "See snowball in Storage section",

    "discovery_service": {
        "full_name": "AWS Application Discovery Service",
        "description": "Discover on-premises servers for migration planning",
    },

    "migration_hub": {
        "full_name": "AWS Migration Hub",
        "description": "Track migration progress across AWS services",
    },

    "cloud_migrator": {
        "full_name": "AWS Migration Acceleration Program (MAP)",
        "description": "Cloud adoption framework and best practices",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 13: AWS MEDIA & GAME SERVICES
# ═══════════════════════════════════════════════════════════════════════════════

AWS_MEDIA_SERVICES = {
    "ivs": {"full_name": "Amazon Interactive Video Service", "description": "Live and on-demand video streaming"},
    "medialive": {"full_name": "AWS Elemental MediaLive", "description": "Live video processing"},
    "mediapackage": {"full_name": "AWS Elemental MediaPackage", "description": "Video packaging and delivery"},
    "mediastore": {"full_name": "AWS Elemental MediaStore", "description": "Media origination and storage"},
    "gamelift": {"full_name": "Amazon GameLift", "description": "Dedicated game servers"},
    "gamedax": {"full_name": "Amazon GameLift Anywhere", "description": "Hybrid game hosting"},
    "sumerian": {"full_name": "Amazon Sumerian", "description": "3D/AR/VR content creation"},
    "lumberyard": {"full_name": "Amazon Lumberyard/O3DE", "description": "Open-source 3D game engine"},
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 14: AWS INTERNET OF THINGS (IoT)
# ═══════════════════════════════════════════════════════════════════════════════

AWS_IOT_SERVICES = {
    "iot_core": {
        "full_name": "AWS IoT Core",
        "description": "Connect IoT devices to AWS cloud",
        "features": ["MQTT/HTTP/WebSocket", "Device Shadow", "Rules Engine", "Jobs", "Fleet Hub", "Device Defender"],
    },
    "iot_greengrass": {"full_name": "AWS IoT Greengrass", "description": "Local compute for IoT devices"},
    "iot_analytics": {"full_name": "AWS IoT Analytics", "description": "IoT data analysis"},
    "iot_site_wise": {"full_name": "AWS IoT SiteWise", "description": "Industrial IoT data collection"},
    "iot_twinmaker": {"full_name": "AWS IoT TwinMaker", "description": "Digital twins"},
    "iot_1click": {"full_name": "AWS IoT 1-Click", "description": "Simple IoT device triggering"},
    "iot_button": {"full_name": "AWS IoT Button", "description": "Cloud-enabled programmable button"},
    "freertos": {"full_name": "FreeRTOS", "description": "RTOS for IoT microcontrollers"},
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 15: AWS ROBOTICS & QUANTUM
# ═══════════════════════════════════════════════════════════════════════════════

AWS_SPECIALIZED_SERVICES = {
    "robomaker": {"full_name": "AWS RoboMaker", "description": "Robot development and simulation"},
    "braket": {"full_name": "Amazon Braket", "description": "Quantum computing service"},
    "ground_station": {"full_name": "AWS Ground Station", "description": "Satellite communication"},
    "snowball_edge": {"full_name": "AWS Snowball Edge", "description": "Edge computing and data transfer"},
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 16: AWS BUSINESS APPLICATIONS
# ═══════════════════════════════════════════════════════════════════════════════

AWS_BUSINESS_SERVICES = {
    "connect": {"full_name": "Amazon Connect", "description": "Cloud contact center"},
    "workspaces": {"full_name": "Amazon WorkSpaces", "description": "Managed desktop computing"},
    "workspaces_web": {"full_name": "Amazon WorkSpaces Web", "description": "Browser-based access to internal apps"},
    "chime": {"full_name": "Amazon Chime", "description": "Video conferencing and messaging"},
    "chime_sdk": {"full_name": "Chime SDK", "description": "Build real-time communication"},
    "pinpoint": {"full_name": "Amazon Pinpoint", "description": "Customer engagement (email, SMS, push)"},
    "ses": {"full_name": "Amazon Simple Email Service", "description": "Transactional and marketing email"},
    "workmail": {"full_name": "Amazon WorkMail", "description": "Managed email and calendaring"},
    "workdocs": {"full_name": "Amazon WorkDocs", "description": "Document storage and sharing"},
    "amplify": {"full_name": "AWS Amplify", "description": "Build full-stack web/mobile apps"},
    "appstream": {"full_name": "Amazon AppStream 2.0", "description": "Application streaming"},
    "workspaces_thin_client": {"full_name": "Amazon WorkSpaces Thin Client", "description": "Thin client for virtual desktops"},
    "managed_blockchain": {"full_name": "Amazon Managed Blockchain", "description": "Blockchain networks (Hyperledger Fabric, Ethereum)"},
    "neptune_analytics": {"full_name": "Amazon Neptune Analytics", "description": "Graph analytics at scale"},
    "entity_resolution": {"full_name": "Amazon Entity Resolution", "description": "Match and link related records"},
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 17: EBS VOLUME TYPES (REFERENCE)
# ═══════════════════════════════════════════════════════════════════════════════

EBS_VOLUME_TYPES = {
    "gp3": {
        "name": "General Purpose SSD (gp3)",
        "min_size_gb": 1, "max_size_gb": 16384,
        "baseline_iops": 3000, "max_iops": 16000,
        "baseline_throughput_mbps": 125, "max_throughput_mbps": 1000,
        "cost_per_gb_month": "$0.08", "cost_per_iops": "$0.005",
        "use_case": "Most workloads (recommended default)",
        "bootable": True,
    },
    "gp2": {
        "name": "General Purpose SSD (gp2)",
        "min_size_gb": 1, "max_size_gb": 16384,
        "baseline_iops": 100, "max_iops": 16000,
        "baseline_throughput_mbps": 128, "max_throughput_mbps": 250,
        "cost_per_gb_month": "$0.10",
        "use_case": "Legacy, boot volumes (gp3 is preferred)",
        "bootable": True,
    },
    "io2": {
        "name": "Provisioned IOPS SSD (io2)",
        "min_size_gb": 4, "max_size_gb": 16384,
        "baseline_iops": 100, "max_iops": 64000,
        "baseline_throughput_mbps": 1000, "max_throughput_mbps": 4000,
        "cost_per_gb_month": "$0.125", "cost_per_iops": "$0.065",
        "use_case": "Mission-critical, latency-sensitive (databases)",
        "bootable": True,
    },
    "st1": {
        "name": "Throughput Optimized HDD (st1)",
        "min_size_gb": 500, "max_size_gb": 16384,
        "baseline_iops": 500, "max_iops": 500,
        "baseline_throughput_mbps": 250, "max_throughput_mbps": 500,
        "cost_per_gb_month": "$0.045",
        "use_case": "Big data, data warehouse, log processing",
        "bootable": False,
    },
    "sc1": {
        "name": "Cold HDD (sc1)",
        "min_size_gb": 500, "max_size_gb": 16384,
        "baseline_iops": 250, "max_iops": 250,
        "baseline_throughput_mbps": 128, "max_throughput_mbps": 250,
        "cost_per_gb_month": "$0.015",
        "use_case": "Infrequently accessed data, archival",
        "bootable": False,
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 18: SECURITY GROUP COMMON RULES
# ═══════════════════════════════════════════════════════════════════════════════

COMMON_SECURITY_GROUP_RULES = {
    "SSH (22)": {"port": 22, "protocol": "tcp", "description": "SSH access"},
    "HTTP (80)": {"port": 80, "protocol": "tcp", "description": "HTTP web traffic"},
    "HTTPS (443)": {"port": 443, "protocol": "tcp", "description": "HTTPS web traffic"},
    "MySQL (3306)": {"port": 3306, "protocol": "tcp", "description": "MySQL database"},
    "PostgreSQL (5432)": {"port": 5432, "protocol": "tcp", "description": "PostgreSQL database"},
    "Redis (6379)": {"port": 6379, "protocol": "tcp", "description": "Redis cache"},
    "SMTP (587)": {"port": 587, "protocol": "tcp", "description": "SMTP email"},
    "DNS (53)": {"port": 53, "protocol": "both", "description": "DNS"},
    "RDP (3389)": {"port": 3389, "protocol": "tcp", "description": "Windows RDP"},
    "Kubernetes API (6443)": {"port": 6443, "protocol": "tcp", "description": "Kubernetes API server"},
    "Kubelet (10250)": {"port": 10250, "protocol": "tcp", "description": "Kubelet API"},
    "ETCD (2379-2380)": {"port": 2380, "protocol": "tcp", "description": "ETCD client/peer communication"},
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 19: AMI SEARCH FILTERS
# ═══════════════════════════════════════════════════════════════════════════════

AMI_SEARCH_FILTERS = {
    "amazon_linux_2023": {
        "owners": ["amazon"],
        "filters": [
            {"name": "name", "values": ["al2023-ami-2023.*-x86_64"]},
            {"name": "state", "values": ["available"]},
            {"name": "architecture", "values": ["x86_64"]},
            {"name": "root-device-type", "values": ["ebs"]},
            {"name": "virtualization-type", "values": ["hvm"]},
        ],
    },
    "ubuntu_22_04": {
        "owners": ["099720109477"],
        "filters": [
            {"name": "name", "values": ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]},
            {"name": "state", "values": ["available"]},
        ],
    },
    "ubuntu_24_04": {
        "owners": ["099720109477"],
        "filters": [
            {"name": "name", "values": ["ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server-*"]},
            {"name": "state", "values": ["available"]},
        ],
    },
    "amazon_linux_2": {
        "owners": ["amazon"],
        "filters": [
            {"name": "name", "values": ["amzn2-ami-hvm-*-x86_64-gp2"]},
            {"name": "state", "values": ["available"]},
        ],
    },
}

OS_RECOMMENDATIONS = {
    "Amazon Linux 2023": {"best_for": "AWS-native workloads", "package_manager": "dnf", "ssh_user": "ec2-user"},
    "Amazon Linux 2": {"best_for": "Legacy AWS workloads", "package_manager": "yum", "ssh_user": "ec2-user"},
    "Ubuntu 22.04 LTS": {"best_for": "General purpose, dev teams", "package_manager": "apt", "ssh_user": "ubuntu"},
    "Ubuntu 24.04 LTS": {"best_for": "Latest LTS, containers", "package_manager": "apt", "ssh_user": "ubuntu"},
    "Windows Server 2022": {"best_for": "Windows/.NET workloads", "package_manager": "choco", "ssh_user": "Administrator"},
    "Red Hat Enterprise Linux 9": {"best_for": "Enterprise, RHEL support", "package_manager": "dnf", "ssh_user": "ec2-user"},
    "Debian 12": {"best_for": "Stable, minimal", "package_manager": "apt", "ssh_user": "admin"},
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 20: TERRAFORM BEST PRACTICES
# ═══════════════════════════════════════════════════════════════════════════════

TERRAFORM_BEST_PRACTICES = {
    "remote_state": {
        "description": "Always use S3 remote backend for production state files",
        "template": '''terraform {
  backend "s3" {
    bucket         = "{state_bucket}"
    key            = "{resource_path}/terraform.tfstate"
    region         = "{region}"
    encrypt        = true
    dynamodb_table = "{lock_table}"
  }
}''',
        "notes": [
            "Enable encryption for state files at rest",
            "Use DynamoDB table for state locking",
            "Store state per environment (dev, staging, prod)",
            "Never store secrets in state files",
        ],
    },
    "provider_config": {
        "description": "Standard AWS provider configuration",
        "template": '''terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Environment = var.environment
      ManagedBy   = "Terraform"
      Project     = var.project_name
    }
  }
}''',
    },
    "security": {
        "rules": [
            "Never hardcode credentials",
            "Enable encryption on all storage (S3, EBS, RDS)",
            "Use private subnets for databases",
            "Apply least-privilege IAM policies",
            "Enable CloudTrail and GuardDuty",
            "Use Secrets Manager/SSM for sensitive values",
            "Restrict security group rules",
        ],
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 21: TERRAFORM COMMON PATTERNS
# ═══════════════════════════════════════════════════════════════════════════════

TERRAFORM_PATTERNS = {
    "ec2_instance": {
        "description": "Standard EC2 instance with security group",
        "template": '''resource "aws_instance" "{name}" {
  ami                    = data.aws_ami.{os}.id
  instance_type          = "{instance_type}"
  key_name              = {key_pair}
  vpc_security_group_ids = [{security_group_ids}]
  subnet_id             = {subnet_id}

  root_block_device {
    volume_size = {storage_gb}
    volume_type = "gp3"
    encrypted   = true
  }

  tags = {
    Name = "{name}"
    {tags}
  }
}''',
    },
    "s3_bucket": {
        "description": "S3 bucket with encryption and versioning",
        "template": '''resource "aws_s3_bucket" "{name}" {
  bucket = "{bucket_name}"
  tags = { Name = "{bucket_name}" }
}

resource "aws_s3_bucket_versioning" "{name}" {
  bucket = aws_s3_bucket.{name}.id
  versioning_configuration { status = "{versioning_status}" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "{name}" {
  bucket = aws_s3_bucket.{name}.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "{encryption_algorithm}"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "{name}" {
  bucket                  = aws_s3_bucket.{name}.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}''',
    },
    "rds_instance": {
        "description": "RDS database instance",
        "template": '''resource "aws_db_instance" "{name}" {
  identifier     = "{db_name}"
  engine         = "{engine}"
  engine_version = "{engine_version}"
  instance_class = "{instance_class}"
  allocated_storage = {storage_gb}
  storage_type    = "gp3"
  storage_encrypted = true
  db_name  = "{db_name}"
  username = "{master_username}"
  password = random_password.db_password.result
  vpc_security_group_ids = [{security_group_ids}]
  db_subnet_group_name   = aws_db_subnet_group.{name}.name
  multi_az               = {multi_az}
  backup_retention_period = {backup_retention}
  deletion_protection = {deletion_protection}
  skip_final_snapshot = {skip_final_snapshot}
  tags = { Name = "{db_name}" }
}''',
    },
    "vpc": {
        "description": "VPC with public and private subnets",
        "template": '''resource "aws_vpc" "{name}" {
  cidr_block           = "{cidr_block}"
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags = { Name = "{vpc_name}" }
}

resource "aws_subnet" "public" {
  count             = {count}
  vpc_id            = aws_vpc.{name}.id
  cidr_block        = cidrsubnet(aws_vpc.{name}.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true
}

resource "aws_subnet" "private" {
  count             = {count}
  vpc_id            = aws_vpc.{name}.id
  cidr_block        = cidrsubnet(aws_vpc.{name}.cidr_block, 8, count.index + {count})
  availability_zone = data.aws_availability_zones.available.names[count.index]
}''',
    },
    "lambda_function": {
        "description": "Lambda function with IAM role",
        "template": '''resource "aws_lambda_function" "{name}" {
  function_name = "{function_name}"
  runtime       = "{runtime}"
  handler       = "{handler}"
  role          = aws_iam_role.{name}.arn
  memory_size   = {memory_mb}
  timeout       = {timeout}
  filename      = "{filename}"
  environment { variables = { {env_vars} } }
}''',
    },
    "ecs_cluster": {
        "description": "ECS Fargate cluster with service",
        "template": '''resource "aws_ecs_cluster" "{name}" {
  name = "{cluster_name}"
}

resource "aws_ecs_task_definition" "{name}" {
  family                   = "{task_name}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = {cpu}
  memory                   = {memory}
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  container_definitions = jsonencode([{
    name  = "{container_name}"
    image = "{container_image}"
    portMappings = [{ containerPort = {container_port} }]
  }])
}

resource "aws_ecs_service" "{name}" {
  name            = "{service_name}"
  cluster         = aws_ecs_cluster.{name}.id
  task_definition = aws_ecs_task_definition.{name}.arn
  desired_count   = {desired_count}
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = [{subnet_ids}]
    security_groups = [{security_group_ids}]
  }
}''',
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 22: KUBERNETES CORE CONCEPTS
# ═══════════════════════════════════════════════════════════════════════════════

KUBERNETES_CORE = {
    "architecture": {
        "control_plane": {
            "components": ["API Server", "etcd", "Scheduler", "Controller Manager", "Cloud Controller Manager"],
            "description": "Manages cluster state and orchestration decisions",
            "api_server": "RESTful API — entry point for all operations (kubectl, dashboard, etc.)",
            "etcd": "Distributed key-value store — holds all cluster state",
            "scheduler": "Assigns pods to nodes based on resource requirements and constraints",
            "controller_manager": "Runs reconciliation loops — ensures desired state matches actual state",
        },
        "worker_nodes": {
            "components": ["Kubelet", "Kube-proxy", "Container Runtime"],
            "kubelet": "Agent on each node — ensures containers are running as specified",
            "kube_proxy": "Network proxy — handles service networking and load balancing",
            "container_runtime": "Runs containers (containerd, CRI-O, Docker — deprecated)",
        },
    },

    "api_objects": {
        "pod": {
            "description": "Smallest deployable unit — one or more containers sharing network/storage",
            "key_fields": ["metadata", "spec", "status"],
            "best_practices": ["One process per pod", "Use init containers for setup", "Set resource requests/limits", "Use liveness/readiness probes"],
        },
        "deployment": {
            "description": "Manages ReplicaSets and pod rollouts",
            "key_fields": ["replicas", "strategy", "selector", "template"],
            "strategies": {
                "RollingUpdate": "Gradual replacement (default) — maxSurge, maxUnavailable",
                "Recreate": "Kill all old pods before creating new ones",
            },
            "features": ["Rollback", "Scale", "Rolling updates", "Pause/resume"],
        },
        "replicaset": {
            "description": "Ensures specified number of pod replicas are running",
            "managed_by": "Deployment (usually not created directly)",
        },
        "statefulset": {
            "description": "Manages stateful applications with stable identity",
            "features": ["Stable network identity (pod-0, pod-1)", "Stable persistent storage", "Ordered deployment/scaling", "Ordered deletion"],
            "use_cases": ["Databases", "Message queues", "Distributed systems"],
        },
        "daemonset": {
            "description": "Runs one pod on every node (or selected nodes)",
            "use_cases": ["Logging agents", "Monitoring agents", "Node exporters", "Network plugins", "Storage daemons"],
        },
        "job": {
            "description": "Runs pods to completion",
            "fields": ["completions", "parallelism", "backoffLimit", "activeDeadlineSeconds"],
            "use_cases": ["Batch processing", "One-off tasks", "Data migration"],
        },
        "cronjob": {
            "description": "Runs Jobs on a schedule (Cron format)",
            "schedule": "Cron format: '* * * * *' (minute hour day month weekday)",
            "concurrencyPolicy": ["Allow", "Forbid", "Replace"],
            "use_cases": ["Scheduled backups", "Report generation", "Cleanup tasks"],
        },
    },

    "networking": {
        "service": {
            "description": "Exposes a set of pods as a network service",
            "types": {
                "ClusterIP": "Internal only (default) — access within cluster",
                "NodePort": "Expose on each node's IP at a static port (30000-32767)",
                "LoadBalancer": "Cloud load balancer (ALB/NLB on AWS)",
                "ExternalName": "CNAME alias to external DNS",
            },
            "session_affinity": "None or ClientIP",
        },
        "ingress": {
            "description": "HTTP/HTTPS routing to services",
            "features": ["Path-based routing", "Host-based routing", "TLS termination", "Name-based virtual hosting"],
            "ingress_controllers": ["NGINX", "ALB Ingress Controller", "Traefik", "Istio", "Kong"],
            "aws_ingress": "Use AWS Load Balancer Controller for ALB/NLB",
        },
        "network_policy": {
            "description": "Firewall rules for pod-to-pod communication",
            "ingress_rules": "Who can connect TO this pod",
            "egress_rules": "Where can this pod connect TO",
            "default": "Allow all (if no policy defined)",
            "use_case": "Microsegmentation, zero-trust networking",
        },
        "dns": {
            "description": "CoreDNS provides DNS for services",
            "naming": "<service-name>.<namespace>.svc.cluster.local",
            "short": "<service-name> (within same namespace)",
            "headless": "Set clusterIP: None for direct pod DNS",
        },
    },

    "storage": {
        "volume": {
            "types": ["emptyDir", "hostPath", "configMap", "secret", "persistentVolumeClaim", "nfs", "awsElasticBlockStore", "persistentVolume"],
        },
        "persistent_volume": {
            "description": "Cluster-level storage provisioned by admin or dynamically",
            "access_modes": ["ReadWriteOnce (RWO)", "ReadOnlyMany (ROX)", "ReadWriteMany (RWX)", "ReadWriteOncePod (RWOP)"],
            "reclaim_policies": ["Retain", "Delete", "Recycle (deprecated)"],
        },
        "persistent_volume_claim": {
            "description": "Request for storage by a user/pod",
            "dynamic_provisioning": "Automatic PV creation when PVC is created (if StorageClass exists)",
        },
        "storage_class": {
            "description": "Defines storage tiers and provisioning",
            "provisioner": "ebs.csi.aws.com (AWS EBS), efs.csi.aws.com (AWS EFS), etc.",
            "parameters": {"type": "gp3", "encrypted": "true"},
            "reclaim_policy": "Delete or Retain",
            "volume_binding_mode": "Immediate or WaitForFirstConsumer",
        },
        "aws_storage_classes": {
            "gp3": "General Purpose SSD (default for most workloads)",
            "gp2": "General Purpose SSD (legacy)",
            "io2": "Provisioned IOPS SSD",
            "sc1": "Cold HDD (cost-optimized)",
            "st1": "Throughput Optimized HDD",
            "efs": "Elastic File System (RWX)",
        },
    },

    "configuration": {
        "configmap": {
            "description": "Store non-sensitive configuration data as key-value pairs",
            "use_cases": ["Environment variables", "Configuration files", "Command-line arguments"],
            "mounted_as": "Environment variables or volume mount files",
        },
        "secret": {
            "description": "Store sensitive data (base64-encoded)",
            "types": ["Opaque", "kubernetes.io/tls", "kubernetes.io/dockerconfigjson", "kubernetes.io/basic-auth", "kubernetes.io/ssh-auth"],
            "storage": "etcd (encrypted at rest with KMS)",
            "best_practices": ["Use external secrets operator (AWS Secrets Manager)", "Enable etcd encryption", "Use RBAC to restrict access"],
        },
        "service_account": {
            "description": "Identity for pods to authenticate with the API server",
            "use_cases": ["AWS IAM Roles for Service Accounts (IRSA)", "Pod-level RBAC"],
        },
    },

    "autoscaling": {
        "horizontal_pod_autoscaler": {
            "description": "Scale pod count based on metrics",
            "metrics": ["CPU utilization", "Memory utilization", "Custom metrics", "External metrics"],
            "target_defaults": {"cpu": "80%", "memory": "80%"},
            "behavior": {"scale_up": "Fast", "scale_down": "Slow"},
        },
        "vertical_pod_autoscaler": {
            "description": "Adjust pod CPU/memory requests and limits",
            "modes": ["Auto", "Recreate", "Off"],
        },
        "cluster_autoscaler": {
            "description": "Scale node count based on pod scheduling needs",
            "on_aws": "Uses Auto Scaling Groups",
            "behavior": "Adds nodes when pods are unschedulable, removes underutilized nodes",
        },
        "karpenter": {
            "description": "Just-in-time node provisioning (alternative to cluster autoscaler)",
            "on_aws": "Creates EC2 instances directly",
            "features": ["Right-sizing", "Spot instances", "Multiple node pools", "Consolidation"],
        },
    },

    "security": {
        "rbac": {
            "description": "Role-Based Access Control",
            "components": ["Role", "ClusterRole", "RoleBinding", "ClusterRoleBinding"],
            "best_practices": ["Least privilege", "Use namespaces", "Avoid cluster-admin", "Audit with Webhook"],
        },
        "pod_security": {
            "standards": {
                "privileged": "Unrestricted — root access, all capabilities",
                "baseline": "Minimally restrictive — prevent known privilege escalations",
                "restricted": "Heavily restricted — follow Pod Security Standards",
            },
            "replaces": "PodSecurityPolicy (deprecated in 1.25)",
        },
        "network_policies": "See networking section above",
        "secrets_encryption": "Enable KMS encryption for etcd secrets",
        "service_mesh": "Istio, Linkerd for mTLS, traffic management, observability",
    },

    "observability": {
        "logging": {
            "approaches": ["Sidecar logging", "Node-level logging (DaemonSet)", "Application-level logging"],
            "tools": ["Fluentd", "Fluent Bit", "CloudWatch Container Insights", "Elasticsearch", "Loki"],
        },
        "monitoring": {
            "tools": ["Prometheus", "Grafana", "Metrics Server", "Datadog", "New Relic"],
            "aws_native": ["CloudWatch Container Insights", "Amazon Managed Prometheus", "Amazon Managed Grafana"],
        },
        "tracing": {
            "tools": ["Jaeger", "Zipkin", "AWS X-Ray", "OpenTelemetry"],
        },
    },

    "namespaces": {
        "description": "Virtual clusters for resource isolation",
        "default_namespaces": {
            "default": "User workloads",
            "kube-system": "Kubernetes system components",
            "kube-public": "Public resources (cluster info)",
            "kube-node-lease": "Node heartbeat/health",
        },
        "use_cases": ["Team separation", "Environment isolation (dev/staging/prod)", "Resource quotas", "RBAC boundaries"],
    },

    "resource_management": {
        "requests": "Minimum resources guaranteed to a pod — used for scheduling",
        "limits": "Maximum resources a pod can use — throttled or OOMKilled if exceeded",
        "best_practices": [
            "Always set requests AND limits",
            "Set requests to expected usage",
            "Set limits to prevent runaway processes",
            "Use LimitRange for default values per namespace",
            "Use ResourceQuota to cap total resources per namespace",
        ],
    },

    "lifecycle": {
        "init_containers": "Run before main containers — for setup, dependencies, waiting",
        "sidecar_containers": "Run alongside main containers — logging, proxies, monitoring",
        "ephemeral_containers": "Debug containers added to running pods",
        "pre_stop_hook": "Run before container termination — graceful shutdown",
        "post_start_hook": "Run after container starts — initialization",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 23: KUBERNETES ON AWS (EKS)
# ═══════════════════════════════════════════════════════════════════════════════

KUBERNETES_ON_AWS = {
    "eks_components": {
        "control_plane": "Managed by AWS — runs in AWS account, multi-AZ",
        "data_plane": "EC2 (managed/self-managed node groups) or Fargate",
        "networking": {
            "vpc_cni": "AWS VPC CNI plugin — pods get VPC IPs (native networking)",
            "cni_options": ["Prefix delegation (more IPs per ENI)", "Security groups for pods"],
        },
        "storage": {
            "ebs_csi_driver": "EBS volumes for pods — supports dynamic provisioning",
            "efs_csi_driver": "EFS for shared storage — multi-AZ, RWX access",
            "fsx_csi_driver": "FSx Lustre for HPC workloads",
        },
    },

    "irsa": {
        "full_name": "IAM Roles for Service Accounts",
        "description": "Map IAM roles to Kubernetes service accounts",
        "use_cases": ["Pod-level AWS permissions", "S3 access", "SQS access", "Secrets Manager access", "ECR pull"],
        "setup": "Create IAM role with OIDC trust policy → annotate Kubernetes SA → mount in pod",
    },

    "pod_identity": {
        "full_name": "EKS Pod Identity",
        "description": "Simplified IAM for pods (replaces IRSA in new approach)",
        "benefit": "No OIDC provider needed — simpler setup",
    },

    "addons": {
        "core_dns": "DNS resolution for services",
        "vpc_cni": "VPC-native networking",
        "kube_proxy": "Node-level networking",
        "ebs_csi_driver": "EBS persistent volumes",
        "pod_identity_agent": "IAM for pods",
        "cloud_watch_observability": "Container Insights",
        "load_balancer_controller": "ALB/NLB for Kubernetes",
        "cert_manager": "TLS certificate management",
        "external_dns": "Route53 DNS automation",
        "metrics_server": "HPA/VPA metrics",
    },

    "load_balancer_controller": {
        "description": "AWS Load Balancer Controller — manages ALB/NLB for Kubernetes",
        "annotations": {
            "alb": {
                "scheme": "internet-facing or internal",
                "target_type": "ip or instance",
                "certificate_arn": "ACM certificate for HTTPS",
                "health_check_path": "Health check endpoint",
                "group.name": "Shared ALB for multiple Ingress",
            },
            "nlb": {
                "scheme": "internet-facing or internal",
                "target_type": "ip or instance",
                "cross_zone_load_balancing": "true",
            },
        },
    },

    "eks_managed_node_groups": {
        "description": "AWS-managed EC2 node groups",
        "features": ["Auto Scaling", "Auto Healing", "AMI updates", "Draining"],
        "instance_types": "Use mixed instance types for resilience and cost",
        "spot_instances": "Use Spot for non-critical workloads (up to 90% savings)",
    },

    "fargate_profiles": {
        "description": "Run pods on Fargate — no EC2 management",
        "match_labels": "Select which pods run on Fargate",
        "use_cases": ["Batch jobs", "CI/CD", "Burst workloads"],
        "limitations": ["No DaemonSet support", "No persistent volumes (EFS only)", "No instance metadata"],
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 24: KUBERNETES TERRAFORM PATTERNS
# ═══════════════════════════════════════════════════════════════════════════════

KUBERNETES_TERRAFORM_PATTERNS = {
    "eks_cluster": {
        "description": "EKS cluster with managed node group",
        "template": '''resource "aws_eks_cluster" "main" {
  name     = "{cluster_name}"
  role_arn = aws_iam_role.eks_cluster.arn
  version  = "{k8s_version}"

  vpc_config {
    subnet_ids              = [{subnet_ids}]
    endpoint_private_access = true
    endpoint_public_access  = true
  }

  tags = { Name = "{cluster_name}" }
}

resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "{node_group_name}"
  node_role_arn   = aws_iam_role.eks_nodes.arn
  subnet_ids      = [{subnet_ids}]
  instance_types  = [{instance_types}]

  scaling_config {
    desired_size = {desired_size}
    min_size     = {min_size}
    max_size     = {max_size}
  }

  update_config {
    max_unavailable = 1
  }
}''',
    },
    "kubernetes_deployment": {
        "description": "Kubernetes Deployment manifest",
        "template": '''apiVersion: apps/v1
kind: Deployment
metadata:
  name: {name}
  namespace: {namespace}
  labels:
    app: {name}
spec:
  replicas: {replicas}
  selector:
    matchLabels:
      app: {name}
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  template:
    metadata:
      labels:
        app: {name}
    spec:
      containers:
      - name: {container_name}
        image: {container_image}:{tag}
        ports:
        - containerPort: {port}
        resources:
          requests:
            memory: "{memory_request}"
            cpu: "{cpu_request}"
          limits:
            memory: "{memory_limit}"
            cpu: "{cpu_limit}"
        livenessProbe:
          httpGet:
            path: /healthz
            port: {port}
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: {port}
          initialDelaySeconds: 5
          periodSeconds: 5''',
    },
    "kubernetes_service": {
        "description": "Kubernetes Service manifest",
        "template": '''apiVersion: v1
kind: Service
metadata:
  name: {name}
  namespace: {namespace}
spec:
  type: {type}
  selector:
    app: {app_label}
  ports:
  - port: {port}
    targetPort: {target_port}
    protocol: TCP''',
    },
    "kubernetes_ingress": {
        "description": "Kubernetes Ingress with AWS ALB",
        "template": '''apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {name}
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: {acm_arn}
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
spec:
  rules:
  - host: {hostname}
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: {service_name}
            port:
              number: {port}''',
    },
    "kubernetes_hpa": {
        "description": "Horizontal Pod Autoscaler",
        "template": '''apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {name}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {deployment_name}
  minReplicas: {min_replicas}
  maxReplicas: {max_replicas}
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: {cpu_target}
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: {memory_target}''',
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 25: AWS NETWORKING CONCEPTS
# ═══════════════════════════════════════════════════════════════════════════════

AWS_NETWORKING = {
    "vpc": {"description": "Virtual Private Cloud — isolated network", "default_cidr": "10.0.0.0/16"},
    "subnets": {"public": "Route to IGW", "private": "Route to NAT Gateway"},
    "security_groups": {"description": "Stateful firewall", "default": "Deny all inbound, allow all outbound"},
    "nat_gateway": {"cost": "$0.045/hr + data processing", "notes": "One per AZ for HA"},
    "cidr_blocks": {
        "common": ["10.0.0.0/16", "172.16.0.0/16", "192.168.0.0/16"],
        "subnet_calc": "cidrsubnet(vpc_cidr, newbits, index)",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 26: COST OPTIMIZATION
# ═══════════════════════════════════════════════════════════════════════════════

COST_OPTIMIZATION = {
    "ec2_tips": ["Reserved Instances (72% savings)", "Spot Instances (90% savings)", "Savings Plans", "Right-sizing", "Stop unused"],
    "s3_tips": ["Intelligent-Tiering", "Lifecycle policies", "Delete incomplete uploads", "Glacier for archival"],
    "rds_tips": ["Reserved Instances", "gp3 over gp2", "Auto Scaling storage", "Aurora Serverless"],
    "general": ["Cost Explorer", "Tagging", "Trusted Advisor", "Compute Optimizer", "Budgets"],
    "kubernetes": ["Spot node groups for non-critical", "Karpenter for right-sizing", "Resource requests/limits", "Cluster autoscaler", "Pod-level rightsizing"],
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 27: TROUBLESHOOTING GUIDE
# ═══════════════════════════════════════════════════════════════════════════════

TROUBLESHOOTING = {
    "terraform": {
        "init_failed": "Check internet, proxy, credentials, run terraform init -upgrade",
        "apply_failed": "Check IAM permissions, resource limits, use terraform import for existing resources",
        "state_conflict": "Check DynamoDB lock table, use terraform force-unlock <lock_id>",
        "provider_error": "Run terraform init -upgrade, check version constraints",
    },
    "ec2": {
        "ssh_timeout": "Check SG port 22, key pair, subnet routing, IGW, public IP",
        "instance_unreachable": "Check public IP, IGW, route table, NACLs",
        "instance_stopped": "Check EBS volume status, snapshot and restore",
    },
    "rds": {
        "connection_refused": "Check SG port 3306/5432, subnet (private), VPC peering",
        "slow_queries": "Enable Performance Insights, check instance class, add read replicas",
        "storage_full": "Enable storage autoscaling, increase allocated_storage",
    },
    "kubernetes": {
        "pod_pending": "Check node resources (kubectl describe node), resource requests, node selectors, taints/tolerations",
        "pod_crash_loop": "Check logs (kubectl logs), OOMKilled (increase memory), readiness/liveness probes",
        "service_unreachable": "Check selector labels, endpoints (kubectl get endpoints), CoreDNS, network policies",
        "image_pull_backoff": "Check image name/tag, ECR credentials, imagePullSecrets",
        "node_not_ready": "Check kubelet, node conditions (kubectl describe node), instance health, VPC CNI",
        "pvc_pending": "Check StorageClass, EBS CSI driver, PVC access mode vs PV",
        "ingress_502": "Check ALB target group health, security groups, target-type (ip vs instance)",
    },
    "eks": {
        "auth_failed": "Check aws-auth ConfigMap, IRSA trust policy, Pod Identity association",
        "cni_issues": "Check VPC CNI version, prefix delegation, security groups for pods",
        "addon_failure": "Check addon versions, IAM permissions, compatibility with K8s version",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 28: TERRAFORM COMMANDS
# ═══════════════════════════════════════════════════════════════════════════════

TERRAFORM_COMMANDS = {
    "init": "terraform init — Initialize, download providers",
    "plan": "terraform plan — Preview changes",
    "apply": "terraform apply — Apply changes",
    "destroy": "terraform destroy — Destroy infrastructure",
    "fmt": "terraform fmt — Format files",
    "validate": "terraform validate — Validate syntax",
    "import": "terraform import — Import existing resources",
    "state_list": "terraform state list — List resources in state",
    "state_rm": "terraform state rm — Remove from state",
    "output": "terraform output — Show outputs",
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 29: AWS SERVICE QUOTAS
# ═══════════════════════════════════════════════════════════════════════════════

AWS_SERVICE_QUOTAS = {
    "ec2": {"vpc_per_region": 5, "elastic_ips": 5, "sg_per_vpc": 2500, "rules_per_sg": 60},
    "s3": {"bucket_name_length": "3-63 chars", "name_rules": "Lowercase, numbers, hyphens, periods"},
    "rds": {"db_instances_per_region": 40, "storage_max": "64 TB"},
    "lambda": {"concurrent_executions": 1000, "timeout_max": 900, "memory_min_mb": 128, "memory_max_mb": 10240},
    "ecs": {"services_per_cluster": 5000},
    "eks": {"clusters_per_account": 100, "node_groups_per_cluster": 750},
    "iam": {"users_per_account": 5000, "roles_per_account": 1000, "policies_per_role": 10},
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 30: MONITORING & OBSERVABILITY
# ═══════════════════════════════════════════════════════════════════════════════

MONITORING_CONCEPTS = {
    "three_pillars": {
        "metrics": "Numerical measurements (CPU, memory, latency, error rate)",
        "logs": "Timestamped records of events",
        "traces": "End-to-end request path across services",
    },
    "prometheus": {
        "common_metrics": ["cpu_usage_percent", "memory_usage_percent", "http_requests_total", "http_request_duration_seconds"],
        "queries": [
            "rate(http_requests_total[5m])",
            "histogram_quantile(0.99, rate(duration_bucket[5m]))",
            "avg(cpu_usage_percent) by (instance)",
        ],
    },
    "grafana": {
        "dashboards": ["Node Exporter", "CloudWatch", "Kubernetes", "Application"],
    },
    "cloudwatch": {
        "features": ["Metrics", "Alarms", "Logs", "Dashboards", "Anomaly Detection", "Synthetics"],
    },
    "kubernetes_observability": {
        "metrics_server": "Resource metrics for HPA/VPA",
        "prometheus_operator": "Auto-discovered Prometheus targets",
        "grafana_loki": "Log aggregation without indexing",
        "opentelemetry": "Vendor-neutral instrumentation",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 31: HELM CHARTS (KUBERNETES PACKAGE MANAGER)
# ═══════════════════════════════════════════════════════════════════════════════

HELM = {
    "description": "Package manager for Kubernetes — like apt/yum for K8s",
    "concepts": {
        "chart": "Package of pre-configured Kubernetes resources",
        "release": "A running instance of a chart",
        "repository": "Collection of charts (like Docker Hub for charts)",
        "values": "Configuration parameters for a chart",
    },
    "common_charts": {
        "ingress-nginx": "NGINX Ingress Controller",
        "cert-manager": "TLS certificate management",
        "prometheus": "Monitoring and alerting",
        "grafana": "Dashboard visualization",
        "external-dns": "DNS automation (Route53)",
        "aws-load-balancer-controller": "ALB/NLB for Kubernetes",
        "sealed-secrets": "Encrypt secrets for Git",
        "argo-cd": "GitOps continuous delivery",
        "bitnami": "Curated application charts",
    },
    "commands": {
        "repo_add": "helm repo add <name> <url>",
        "repo_update": "helm repo update",
        "search": "helm search repo <keyword>",
        "install": "helm install <release> <chart> --values values.yaml",
        "upgrade": "helm upgrade <release> <chart>",
        "rollback": "helm rollback <release> <revision>",
        "uninstall": "helm uninstall <release>",
        "list": "helm list",
        "diff": "helm diff (with plugin)",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 32: CI/CD PATTERNS
# ═══════════════════════════════════════════════════════════════════════════════

CICD_PATTERNS = {
    "gitops": {
        "description": "Git as single source of truth for infrastructure and deployments",
        "tools": ["ArgoCD", "Flux CD", "AWS CodePipeline"],
        "workflow": "Push to Git → ArgoCD/Flux detects change → Applies to cluster",
        "benefits": ["Audit trail", "Rollback", "Consistency", "Collaboration"],
    },
    "blue_green": {
        "description": "Deploy new version alongside old, switch traffic",
        "use_case": "Zero-downtime deployments",
        "aws_services": ["ECS blue/green via CodeDeploy", "ALB target groups", "Route53 weighted routing"],
    },
    "canary": {
        "description": "Gradually route traffic to new version",
        "use_case": "Testing new versions with small traffic percentage",
        "aws_services": ["ALB weighted target groups", "Route53 weighted routing", "App Mesh"],
    },
    "rolling_update": {
        "description": "Gradually replace old pods/instances with new ones",
        "kubernetes": "Deployment strategy — maxSurge, maxUnavailable",
        "ecs": "DeploymentConfiguration — minimumHealthyPercent, maximumPercent",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 33: SCHEDULER PATTERNS
# ═══════════════════════════════════════════════════════════════════════════════

SCHEDULER_PATTERNS = {
    "examples": [
        {"input": "3am", "description": "Tomorrow at 3:00 AM UTC"},
        {"input": "tomorrow 9am", "description": "Tomorrow at 9:00 AM UTC"},
        {"input": "in 2 hours", "description": "2 hours from now"},
        {"input": "in 30 minutes", "description": "30 minutes from now"},
        {"input": "every day at midnight", "description": "Daily at 12:00 AM UTC (cron)"},
        {"input": "every day at 3am", "description": "Daily at 3:00 AM UTC (cron)"},
        {"input": "every hour", "description": "Every hour on the hour (cron)"},
    ],
    "cron_patterns": {
        "daily_midnight": {"hour": 0, "minute": 0},
        "daily_3am": {"hour": 3, "minute": 0},
        "every_hour": {"minute": 0},
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# HELPER FUNCTIONS
# ═══════════════════════════════════════════════════════════════════════════════

def get_instance_recommendation(workload_type: str) -> dict:
    """Recommend instance type based on workload type."""
    recommendations = {
        "web_server": {"primary": "t3.medium", "high_perf": "m5.large", "budget": "t3.small"},
        "api_server": {"primary": "t3.medium", "high_perf": "m5.xlarge", "budget": "t3.small"},
        "database": {"primary": "r5.large", "high_perf": "r5.2xlarge", "budget": "t3.medium"},
        "batch_processing": {"primary": "c5.xlarge", "high_perf": "c5.4xlarge", "budget": "c5.large"},
        "dev_test": {"primary": "t3.micro", "high_perf": "t3.small", "budget": "t3.micro"},
        "container": {"primary": "t3.medium", "high_perf": "m5.xlarge", "budget": "t3.small"},
        "machine_learning": {"primary": "p3.2xlarge", "high_perf": "p4d.24xlarge", "budget": "g4dn.xlarge"},
        "in_memory_cache": {"primary": "r5.large", "high_perf": "r5.2xlarge", "budget": "m5.large"},
        "kubernetes_node": {"primary": "m5.xlarge", "high_perf": "m5.4xlarge", "budget": "t3.xlarge"},
        "elasticsearch": {"primary": "m5.xlarge.elasticsearch", "high_perf": "r5.2xlarge.elasticsearch", "budget": "t3.small.elasticsearch"},
        "kafka": {"primary": "kafka.m5.large", "high_perf": "kafka.m5.4xlarge", "budget": "kafka.m5.large"},
    }
    return recommendations.get(workload_type, recommendations["web_server"])


def get_s3_lifecycle_recommendation(data_access_pattern: str) -> list:
    """Recommend S3 lifecycle rules based on data access pattern."""
    lifecycles = {
        "hot": [{"action": "None", "days": 0, "note": "Keep in S3 Standard"}],
        "warm": [
            {"action": "Transition to IA", "days": 30},
            {"action": "Transition to Glacier IR", "days": 90},
        ],
        "cold": [
            {"action": "Transition to IA", "days": 30},
            {"action": "Transition to Glacier", "days": 60},
            {"action": "Transition to Glacier Deep Archive", "days": 180},
        ],
        "archive": [
            {"action": "Transition to Glacier", "days": 1},
            {"action": "Transition to Deep Archive", "days": 30},
            {"action": "Delete", "days": 365},
        ],
    }
    return lifecycles.get(data_access_pattern, lifecycles["hot"])


def get_kubernetes_resources_for_workload(workload_type: str) -> dict:
    """Recommend Kubernetes resource requests/limits for common workloads."""
    resources = {
        "web_server": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"cpu": "500m", "memory": "512Mi"}},
        "api_server": {"requests": {"cpu": "250m", "memory": "256Mi"}, "limits": {"cpu": "1000m", "memory": "1Gi"}},
        "database": {"requests": {"cpu": "500m", "memory": "1Gi"}, "limits": {"cpu": "2000m", "memory": "4Gi"}},
        "worker": {"requests": {"cpu": "250m", "memory": "256Mi"}, "limits": {"cpu": "1000m", "memory": "1Gi"}},
        "batch_job": {"requests": {"cpu": "1000m", "memory": "2Gi"}, "limits": {"cpu": "4000m", "memory": "8Gi"}},
        "sidecar": {"requests": {"cpu": "50m", "memory": "64Mi"}, "limits": {"cpu": "200m", "memory": "256Mi"}},
        "monitoring_agent": {"requests": {"cpu": "100m", "memory": "128Mi"}, "limits": {"cpu": "500m", "memory": "512Mi"}},
    }
    return resources.get(workload_type, resources["web_server"])


def get_aws_service_arn(service: str, region: str = "*", account: str = "*") -> str:
    """Generate common AWS ARN patterns."""
    arns = {
        "ec2": f"arn:aws:ec2:{region}:{account}:instance/*",
        "s3": f"arn:aws:s3:::*",
        "rds": f"arn:aws:rds:{region}:{account}:db:*",
        "lambda": f"arn:aws:lambda:{region}:{account}:function:*",
        "ecs": f"arn:aws:ecs:{region}:{account}:service/*",
        "eks": f"arn:aws:eks:{region}:{account}:cluster/*",
        "sqs": f"arn:aws:sqs:{region}:{account}:*",
        "sns": f"arn:aws:sns:{region}:{account}:*",
        "dynamodb": f"arn:aws:dynamodb:{region}:{account}:table/*",
        "kms": f"arn:aws:kms:{region}:{account}:key/*",
        "iam": f"arn:aws:iam::{account}:role/*",
        "cloudwatch": f"arn:aws:cloudwatch:{region}:{account}:alarm:*",
    }
    return arns.get(service, f"arn:aws:{service}:{region}:{account}:*")


# ═══════════════════════════════════════════════════════════════════════════════
# LOOKUP INDEX — Maps service names to their sections
# ═══════════════════════════════════════════════════════════════════════════════

SERVICE_INDEX = {
    "ec2": AWS_COMPUTE_SERVICES["ec2"],
    "lambda": AWS_COMPUTE_SERVICES["lambda"],
    "ecs": AWS_COMPUTE_SERVICES["ecs"],
    "eks": AWS_COMPUTE_SERVICES["eks"],
    "fargate": AWS_COMPUTE_SERVICES["fargate"],
    "batch": AWS_COMPUTE_SERVICES["batch"],
    "s3": AWS_STORAGE_SERVICES["s3"],
    "ebs": AWS_STORAGE_SERVICES["ebs"],
    "efs": AWS_STORAGE_SERVICES["efs"],
    "fsx": AWS_STORAGE_SERVICES["fsx"],
    "rds": AWS_DATABASE_SERVICES["rds"],
    "aurora": AWS_DATABASE_SERVICES["aurora"],
    "dynamodb": AWS_DATABASE_SERVICES["dynamodb"],
    "elasticache": AWS_DATABASE_SERVICES["elasticache"],
    "redshift": AWS_DATABASE_SERVICES["redshift"],
    "vpc": AWS_NETWORKING_SERVICES["vpc"],
    "route53": AWS_NETWORKING_SERVICES["route53"],
    "cloudfront": AWS_NETWORKING_SERVICES["cloudfront"],
    "alb": AWS_NETWORKING_SERVICES["alb"],
    "nlb": AWS_NETWORKING_SERVICES["nlb"],
    "api_gateway": AWS_NETWORKING_SERVICES["api_gateway"],
    "transit_gateway": AWS_NETWORKING_SERVICES["transit_gateway"],
    "iam": AWS_SECURITY_SERVICES["iam"],
    "kms": AWS_SECURITY_SERVICES["kms"],
    "secrets_manager": AWS_SECURITY_SERVICES["secrets_manager"],
    "waf": AWS_SECURITY_SERVICES["waf"],
    "shield": AWS_SECURITY_SERVICES["shield"],
    "guardduty": AWS_SECURITY_SERVICES["guardduty"],
    "cloudwatch": AWS_MANAGEMENT_SERVICES["cloudwatch"],
    "cloudtrail": AWS_MANAGEMENT_SERVICES["cloudtrail"],
    "cloudformation": AWS_MANAGEMENT_SERVICES["cloudformation"],
    "sqs": AWS_APPLICATION_INTEGRATION["sqs"],
    "sns": AWS_APPLICATION_INTEGRATION["sns"],
    "eventbridge": AWS_APPLICATION_INTEGRATION["eventbridge"],
    "step_functions": AWS_APPLICATION_INTEGRATION["step_functions"],
    "kinesis": AWS_APPLICATION_INTEGRATION["kinesis_data_streams"],
    "athena": AWS_ANALYTICS_SERVICES["athena"],
    "glue": AWS_ANALYTICS_SERVICES["glue"],
    "emr": AWS_ANALYTICS_SERVICES["emr"],
    "opensearch": AWS_ANALYTICS_SERVICES["opensearch"],
    "sagemaker": AWS_ML_SERVICES["sagemaker"],
    "bedrock": AWS_ML_SERVICES["bedrock"],
    "ecr": AWS_CONTAINER_SERVICES["ecr"],
    "dms": AWS_MIGRATION_SERVICES["dms"],
    "transfer_family": AWS_MIGRATION_SERVICES["transfer_family"],
    "kubernetes": KUBERNETES_CORE,
    "eks_k8s": KUBERNETES_ON_AWS,
    "helm": HELM,
}