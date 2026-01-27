import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Building2,
  Search,
  MoreVertical,
  Trash2,
  Mail,
  Phone,
  Users,
  GraduationCap,
  Clock,
  CheckCircle,
  XCircle,
  MessageSquare,
  ArrowLeft,
  ExternalLink
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { formatDistanceToNow, format } from "date-fns";

interface TrialRequest {
  id: string;
  schoolName: string;
  schoolDomain: string;
  adminFirstName: string;
  adminLastName: string;
  adminEmail: string;
  adminPhone: string | null;
  estimatedStudents: string | null;
  estimatedTeachers: string | null;
  message: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  processedAt: string | null;
  processedBy: string | null;
}

export default function TrialRequests() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [requestToDelete, setRequestToDelete] = useState<TrialRequest | null>(null);
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<TrialRequest | null>(null);
  const [editNotes, setEditNotes] = useState("");

  const { data: requests = [], isLoading } = useQuery<TrialRequest[]>({
    queryKey: ['/api/super-admin/trial-requests', statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== 'all') params.append('status', statusFilter);

      const response = await fetch(`/api/super-admin/trial-requests?${params}`);
      if (!response.ok) throw new Error('Failed to fetch trial requests');
      return response.json();
    },
  });

  // Filter by search query
  const filteredRequests = requests.filter(req => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      req.schoolName.toLowerCase().includes(query) ||
      req.schoolDomain.toLowerCase().includes(query) ||
      req.adminEmail.toLowerCase().includes(query) ||
      `${req.adminFirstName} ${req.adminLastName}`.toLowerCase().includes(query)
    );
  });

  // Count by status
  const statusCounts = {
    pending: requests.filter(r => r.status === 'pending').length,
    contacted: requests.filter(r => r.status === 'contacted').length,
    converted: requests.filter(r => r.status === 'converted').length,
    declined: requests.filter(r => r.status === 'declined').length,
  };

  const updateMutation = useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status?: string; notes?: string }) => {
      return await apiRequest("PATCH", `/api/super-admin/trial-requests/${id}`, { status, notes });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/trial-requests'] });
      toast({
        title: "Request updated",
        description: "The trial request has been updated",
      });
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to update request",
        description: error.message || "An error occurred",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return await apiRequest("DELETE", `/api/super-admin/trial-requests/${id}`, {});
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/trial-requests'] });
      toast({
        title: "Request deleted",
        description: "The trial request has been deleted",
      });
      setDeleteDialogOpen(false);
      setRequestToDelete(null);
    },
    onError: (error: any) => {
      toast({
        variant: "destructive",
        title: "Failed to delete request",
        description: error.message || "An error occurred",
      });
    },
  });

  const getStatusBadge = (status: string) => {
    const config: Record<string, { variant: "default" | "secondary" | "destructive" | "outline"; icon: any; label: string }> = {
      pending: { variant: "secondary", icon: Clock, label: "Pending" },
      contacted: { variant: "outline", icon: MessageSquare, label: "Contacted" },
      converted: { variant: "default", icon: CheckCircle, label: "Converted" },
      declined: { variant: "destructive", icon: XCircle, label: "Declined" },
    };
    const { variant, icon: Icon, label } = config[status] || config.pending;
    return (
      <Badge variant={variant} className="flex items-center gap-1">
        <Icon className="w-3 h-3" />
        {label}
      </Badge>
    );
  };

  const handleViewDetails = (request: TrialRequest) => {
    setSelectedRequest(request);
    setEditNotes(request.notes || "");
    setDetailsDialogOpen(true);
  };

  const handleUpdateStatus = (id: string, status: string) => {
    updateMutation.mutate({ id, status });
  };

  const handleSaveNotes = () => {
    if (selectedRequest) {
      updateMutation.mutate({ id: selectedRequest.id, notes: editNotes });
      setSelectedRequest({ ...selectedRequest, notes: editNotes });
    }
  };

  const handleDelete = (request: TrialRequest) => {
    setRequestToDelete(request);
    setDeleteDialogOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading trial requests...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-6">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => setLocation("/super-admin/schools")}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold">Trial Requests</h1>
            <p className="text-muted-foreground mt-1">
              Review and manage incoming trial requests from schools
            </p>
          </div>
        </div>

        {/* Summary Stats */}
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <Card
            className={`cursor-pointer transition-colors ${statusFilter === 'pending' ? 'ring-2 ring-primary' : ''}`}
            onClick={() => setStatusFilter(statusFilter === 'pending' ? 'all' : 'pending')}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Pending</CardTitle>
              <Clock className="w-4 h-4 text-yellow-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statusCounts.pending}</div>
              <p className="text-xs text-muted-foreground">Awaiting review</p>
            </CardContent>
          </Card>
          <Card
            className={`cursor-pointer transition-colors ${statusFilter === 'contacted' ? 'ring-2 ring-primary' : ''}`}
            onClick={() => setStatusFilter(statusFilter === 'contacted' ? 'all' : 'contacted')}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Contacted</CardTitle>
              <MessageSquare className="w-4 h-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statusCounts.contacted}</div>
              <p className="text-xs text-muted-foreground">In progress</p>
            </CardContent>
          </Card>
          <Card
            className={`cursor-pointer transition-colors ${statusFilter === 'converted' ? 'ring-2 ring-primary' : ''}`}
            onClick={() => setStatusFilter(statusFilter === 'converted' ? 'all' : 'converted')}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Converted</CardTitle>
              <CheckCircle className="w-4 h-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statusCounts.converted}</div>
              <p className="text-xs text-muted-foreground">Became customers</p>
            </CardContent>
          </Card>
          <Card
            className={`cursor-pointer transition-colors ${statusFilter === 'declined' ? 'ring-2 ring-primary' : ''}`}
            onClick={() => setStatusFilter(statusFilter === 'declined' ? 'all' : 'declined')}
          >
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Declined</CardTitle>
              <XCircle className="w-4 h-4 text-red-500" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{statusCounts.declined}</div>
              <p className="text-xs text-muted-foreground">Not interested</p>
            </CardContent>
          </Card>
        </div>

        {/* Search and Filters */}
        <div className="flex gap-4 mb-6">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search by school name, domain, or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="contacted">Contacted</SelectItem>
              <SelectItem value="converted">Converted</SelectItem>
              <SelectItem value="declined">Declined</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Requests List */}
        <div className="space-y-4">
          {filteredRequests.map((request) => (
            <Card key={request.id} className="hover-elevate">
              <CardContent className="p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-3">
                    {/* Header */}
                    <div className="flex items-center gap-3">
                      <Building2 className="w-5 h-5 text-primary" />
                      <h3 className="text-lg font-semibold">{request.schoolName}</h3>
                      {getStatusBadge(request.status)}
                    </div>

                    {/* Details Grid */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <p className="text-muted-foreground">Domain</p>
                        <p className="font-medium">{request.schoolDomain}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Contact</p>
                        <p className="font-medium">{request.adminFirstName} {request.adminLastName}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Est. Students</p>
                        <p className="font-medium flex items-center gap-1">
                          <GraduationCap className="w-4 h-4" />
                          {request.estimatedStudents || "Not specified"}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Est. Teachers</p>
                        <p className="font-medium flex items-center gap-1">
                          <Users className="w-4 h-4" />
                          {request.estimatedTeachers || "Not specified"}
                        </p>
                      </div>
                    </div>

                    {/* Contact Info */}
                    <div className="flex items-center gap-4 text-sm text-muted-foreground">
                      <a
                        href={`mailto:${request.adminEmail}`}
                        className="flex items-center gap-1 hover:text-primary"
                      >
                        <Mail className="w-4 h-4" />
                        {request.adminEmail}
                      </a>
                      {request.adminPhone && (
                        <a
                          href={`tel:${request.adminPhone}`}
                          className="flex items-center gap-1 hover:text-primary"
                        >
                          <Phone className="w-4 h-4" />
                          {request.adminPhone}
                        </a>
                      )}
                    </div>

                    {/* Message Preview */}
                    {request.message && (
                      <p className="text-sm text-muted-foreground line-clamp-2 italic">
                        "{request.message}"
                      </p>
                    )}

                    {/* Timestamps */}
                    <p className="text-xs text-muted-foreground">
                      Submitted {formatDistanceToNow(new Date(request.createdAt), { addSuffix: true })}
                      {request.processedAt && (
                        <> · Updated {formatDistanceToNow(new Date(request.processedAt), { addSuffix: true })}</>
                      )}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => handleViewDetails(request)}>
                      View Details
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreVertical className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleUpdateStatus(request.id, 'contacted')}>
                          <MessageSquare className="w-4 h-4 mr-2" />
                          Mark as Contacted
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleUpdateStatus(request.id, 'converted')}>
                          <CheckCircle className="w-4 h-4 mr-2" />
                          Mark as Converted
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleUpdateStatus(request.id, 'declined')}>
                          <XCircle className="w-4 h-4 mr-2" />
                          Mark as Declined
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setLocation("/super-admin/schools/new")}>
                          <ExternalLink className="w-4 h-4 mr-2" />
                          Create School
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDelete(request)}
                          className="text-destructive"
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Delete Request
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {filteredRequests.length === 0 && (
          <Card className="p-12 text-center">
            <Mail className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-lg font-semibold mb-2">No trial requests found</p>
            <p className="text-muted-foreground">
              {searchQuery || statusFilter !== 'all'
                ? "Try adjusting your search or filters"
                : "Trial requests from schools will appear here"}
            </p>
          </Card>
        )}
      </div>

      {/* Details Dialog */}
      <Dialog open={detailsDialogOpen} onOpenChange={setDetailsDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5" />
              {selectedRequest?.schoolName}
            </DialogTitle>
            <DialogDescription>
              Trial request details and notes
            </DialogDescription>
          </DialogHeader>

          {selectedRequest && (
            <div className="space-y-6">
              {/* Status */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Status</span>
                <Select
                  value={selectedRequest.status}
                  onValueChange={(status) => {
                    handleUpdateStatus(selectedRequest.id, status);
                    setSelectedRequest({ ...selectedRequest, status });
                  }}
                >
                  <SelectTrigger className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="contacted">Contacted</SelectItem>
                    <SelectItem value="converted">Converted</SelectItem>
                    <SelectItem value="declined">Declined</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* School Info */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">School Information</h4>
                <div className="grid grid-cols-2 gap-4 text-sm bg-muted/50 p-4 rounded-lg">
                  <div>
                    <p className="text-muted-foreground">School Name</p>
                    <p className="font-medium">{selectedRequest.schoolName}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Domain</p>
                    <p className="font-medium">{selectedRequest.schoolDomain}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Estimated Students</p>
                    <p className="font-medium">{selectedRequest.estimatedStudents || "Not specified"}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Estimated Teachers</p>
                    <p className="font-medium">{selectedRequest.estimatedTeachers || "Not specified"}</p>
                  </div>
                </div>
              </div>

              {/* Contact Info */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">Administrator Contact</h4>
                <div className="grid grid-cols-2 gap-4 text-sm bg-muted/50 p-4 rounded-lg">
                  <div>
                    <p className="text-muted-foreground">Name</p>
                    <p className="font-medium">{selectedRequest.adminFirstName} {selectedRequest.adminLastName}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Email</p>
                    <a href={`mailto:${selectedRequest.adminEmail}`} className="font-medium text-primary hover:underline">
                      {selectedRequest.adminEmail}
                    </a>
                  </div>
                  {selectedRequest.adminPhone && (
                    <div>
                      <p className="text-muted-foreground">Phone</p>
                      <a href={`tel:${selectedRequest.adminPhone}`} className="font-medium text-primary hover:underline">
                        {selectedRequest.adminPhone}
                      </a>
                    </div>
                  )}
                </div>
              </div>

              {/* Message */}
              {selectedRequest.message && (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold">Message</h4>
                  <div className="text-sm bg-muted/50 p-4 rounded-lg whitespace-pre-wrap">
                    {selectedRequest.message}
                  </div>
                </div>
              )}

              {/* Notes */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">Internal Notes</h4>
                <Textarea
                  placeholder="Add notes about this request..."
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={3}
                />
                <Button
                  size="sm"
                  onClick={handleSaveNotes}
                  disabled={editNotes === (selectedRequest.notes || "")}
                >
                  Save Notes
                </Button>
              </div>

              {/* Timestamps */}
              <div className="text-xs text-muted-foreground border-t pt-4">
                <p>Submitted: {format(new Date(selectedRequest.createdAt), "PPpp")}</p>
                {selectedRequest.processedAt && (
                  <p>Last updated: {format(new Date(selectedRequest.processedAt), "PPpp")}</p>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setLocation("/super-admin/schools/new")}>
              Create School for This Request
            </Button>
            <Button onClick={() => setDetailsDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Trial Request</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this trial request? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-4">
            <p className="text-sm font-medium">School: {requestToDelete?.schoolName}</p>
            <p className="text-sm text-muted-foreground">Contact: {requestToDelete?.adminEmail}</p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeleteDialogOpen(false);
                setRequestToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => requestToDelete && deleteMutation.mutate(requestToDelete.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
