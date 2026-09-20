function payload = export_demo_data(filename, signals, attitudeUnit, tiltUnit, metadata)
%EXPORT_DEMO_DATA Export validated MATLAB signals for the web demo.
% Does not run a model, read the base workspace, or change the source data.
%
% Required signals: t, x, y, z, roll, pitch, yaw, tilt, refX, refY, refZ.
% Position units must be metres and time must be seconds.
% Explicitly pass attitudeUnit and tiltUnit as 'rad' or 'deg'.
% All signals must be finite real vectors on exactly the same time grid.
% A signal can also be a scalar-valued timeseries on that grid.
%
% Example after running the supplied model (current model variable names):
%   s = struct;
%   s.t=t; s.x=x; s.y=y; s.z=z;
%   s.roll=fan; s.pitch=theta; s.yaw=psi; s.tilt=beta;
%   s.refX=xd; s.refY=yd; s.refZ=zd;
%   s.u1=u11; s.u2=u21; s.u3=u31; s.u4=u41;
%   s.w1=w11; s.w2=w21; s.w3=w31; s.w4=w41;
%   m=struct('title','My MATLAB run','source','matlab2018b.slx', ...
%            'controller','PID','description','Exported from a fresh run');
%   export_demo_data('my-run.json',s,'rad','deg',m);
%
% If your run uses x1/y1/z1/fan1/theta1/psi1, explicitly map those variables
% instead. Do not guess variable names or overwrite good data with old values.
% Import my-run.json using the website's local JSON import button.

    narginchk(4,5);
    if nargin < 5, metadata = struct; end
    if ~(isstruct(signals) && isscalar(signals))
        error('TiltDemo:Signals','signals must be a scalar struct.');
    end
    if ~(isstruct(metadata) && isscalar(metadata))
        error('TiltDemo:Metadata','metadata must be a scalar struct.');
    end
    attitudeUnit = validatestring(attitudeUnit,{'rad','deg'});
    tiltUnit = validatestring(tiltUnit,{'rad','deg'});
    filename = char(filename);
    if isempty(filename), error('TiltDemo:Filename','A filename is required.'); end

    required = {'t','x','y','z','roll','pitch','yaw','tilt','refX','refY','refZ'};
    for k=1:numel(required)
        if ~isfield(signals,required{k})
            error('TiltDemo:Missing','Missing required signal: %s',required{k});
        end
    end
    t = signals.t;
    if isa(t,'timeseries'), t = t.Time; end
    validateattributes(t,{'numeric'},{'real','finite','vector','nonempty'},mfilename,'t');
    t = double(t(:));
    if numel(t)<2 || any(diff(t)<=0)
        error('TiltDemo:Time','Time must contain at least two strictly increasing samples.');
    end
    n = numel(t);
    optional = {'u1','u2','u3','u4','w1','w2','w3','w4','ex','ey','ez','eRoll','ePitch','eYaw'};
    fields = [required, optional(isfield(signals,optional))];
    columns = zeros(n,numel(fields));
    columns(:,1) = t;
    for k=2:numel(fields)
        key = fields{k};
        value = signals.(key);
        if isa(value,'timeseries')
            st = double(value.Time(:));
            tolerance = 1e-9*max(1,max(abs(t)));
            if numel(st)~=n || any(abs(st-t)>tolerance)
                error('TiltDemo:TimeGrid','%s has a different time grid; resample explicitly first.',key);
            end
            value = squeeze(value.Data);
        end
        validateattributes(value,{'numeric'},{'real','finite','vector','numel',n},mfilename,key);
        columns(:,k) = double(value(:));
        if ismember(key,{'roll','pitch','yaw','eRoll','ePitch','eYaw'}) && strcmp(attitudeUnit,'deg')
            columns(:,k) = columns(:,k)*pi/180;
        elseif strcmp(key,'tilt') && strcmp(tiltUnit,'deg')
            columns(:,k) = columns(:,k)*pi/180;
        end
    end
    samples = cell2struct(num2cell(columns),fields,2);

    if ~isfield(metadata,'title'), metadata.title='MATLAB simulation export'; end
    if ~isfield(metadata,'source'), metadata.source='User-provided MATLAB signals'; end
    if ~isfield(metadata,'description'), metadata.description='Exported signals; no model run performed by this exporter.'; end
    if ~isfield(metadata,'kind'), metadata.kind='recorded'; end
    metadata.kind = validatestring(metadata.kind,{'recorded','synthetic'});
    metadata.angleUnit='rad'; metadata.positionUnit='m'; metadata.timeUnit='s';
    metadata.sampleCount=n;
    metadata.inputAttitudeUnit=attitudeUnit; metadata.inputTiltUnit=tiltUnit;
    if ~isfield(metadata,'axisConvention')
        metadata.axisConvention='Right-handed x/y/z, z up. R=Rz(yaw)*Ry(pitch)*Rx(roll). Verify the model convention before import.';
    end
    if ~isfield(metadata,'limitations'), metadata.limitations={}; end
    payload = struct('schemaVersion',1,'metadata',metadata,'samples',samples);
    encoded = jsonencode(payload);
    [fid,message] = fopen(filename,'w','n','UTF-8');
    if fid<0, error('TiltDemo:Write','Cannot write file: %s',message); end
    cleanup = onCleanup(@() fclose(fid));
    fprintf(fid,'%s\n',encoded);
    fprintf('Exported %d samples, %.6g to %.6g s: %s\n',n,t(1),t(end),filename);
end
